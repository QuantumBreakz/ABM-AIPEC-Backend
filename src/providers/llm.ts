/**
 * The AI model (OpenRouter free tier with multi-key rotation, or Anthropic Claude).
 * OFF unless at least one OpenRouter key or LLM_API_KEY is set: without it nothing is generated
 * and drafts stay "pending" (FR-31, zero-new-cost rule).
 *
 * - Key rotation: supports up to 3 (or more) OpenRouter keys via OPENROUTER_API_KEY_1..3,
 *   OPENROUTER_API_KEYS (comma-separated), or OPENROUTER_API_KEY. Calls round-robin across
 *   healthy keys and automatically fail over on 429 rate-limits, 402 quota exhaustion, or 401/403.
 * - Structured outputs: the answer must match a zod schema (`messages.parse` or JSON object response), so we never parse free text.
 * - Rate limits: BullMQ retries the job with backoff if all keys are rate-limited. The worker is throttled to LLM_RPM requests per minute.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_OR_QUOTA_COOLDOWN_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

let keyCursor = 0;
const keyCooldownUntil = new Map<string, number>();

/** Collect all unique, non-empty OpenRouter keys from env in priority order. */
export function getOpenRouterKeys(): string[] {
  const candidates: string[] = [];
  const pushSplit = (raw?: string) => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed) candidates.push(trimmed);
    }
  };

  pushSplit(env.OPENROUTER_API_KEYS);
  pushSplit(env.OPENROUTER_API_KEY);
  pushSplit(env.OPENROUTER_API_KEY_1);
  pushSplit(env.OPENROUTER_API_KEY_2);
  pushSplit(env.OPENROUTER_API_KEY_3);

  if (env.LLM_API_KEY?.trim() && (env.LLM_API_KEY.startsWith('sk-or-') || env.LLM_BASE_URL.includes('openrouter.ai'))) {
    // Only treat generic LLM_API_KEY as OpenRouter when it isn't an explicit Anthropic key.
    if (!env.LLM_API_KEY.startsWith('sk-ant-')) {
      pushSplit(env.LLM_API_KEY);
    }
  }

  return [...new Set(candidates)];
}

export const llmEnabled = () => getOpenRouterKeys().length > 0 || !!env.LLM_API_KEY?.trim();

/** Reset rotation cursor and cooldowns (for tests). */
export function resetLlmRotation() {
  keyCursor = 0;
  keyCooldownUntil.clear();
}

/** Reasons shown on a draft that wasn't (or isn't yet) written. */
export const AI_REASON = {
  generating: 'Generating a new draft…',
  noModel: 'No language model is available, so no draft was generated.',
  noFactsCompany: 'No sourced company fact is available to cite, so no draft was written.',
  noFactsContact: 'Not enough sourced facts about this company.',
  optedOut: 'This person opted out, so no draft is written.',
};

/** Stops this draft and becomes its reason (not retried). */
export class LlmStop extends Error {}

// Models that accept server-side refusal fallbacks on Anthropic.
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

let client: Anthropic | undefined;
const getAnthropicClient = () => {
  client ??= new Anthropic({ apiKey: env.LLM_API_KEY, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });
  return client;
};

/** Pick ordered keys for this request: healthy keys in round-robin order first, then cooled-down keys as fallback. */
function orderedKeysForAttempt(keys: string[]): string[] {
  const now = Date.now();
  const start = keyCursor % keys.length;
  keyCursor = (keyCursor + 1) % keys.length;

  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const healthy = rotated.filter((k) => (keyCooldownUntil.get(k) ?? 0) <= now);
  return healthy.length ? healthy : rotated;
}

async function callOpenRouterWithKey<S extends z.ZodType>(
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  schema: S,
  useJsonFormat = true,
): Promise<z.infer<S>> {
  const url = `${env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: `${system}\n\nCRITICAL: Respond ONLY with a raw JSON object matching the requested schema. No code fences (no \`\`\`json), no preamble, no markdown.`,
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };
  if (useJsonFormat) payload.response_format = { type: 'json_object' };

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/QuantumBreakz/ABM-AIPEC-Backend',
      'X-Title': 'ABM-AIPEC Outreach Agent',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 400 && useJsonFormat) {
      return callOpenRouterWithKey(apiKey, model, system, prompt, schema, false);
    }
    const errText = await response.text().catch(() => '');
    const err = new Error(`OpenRouter API error (${response.status}): ${errText}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; refusal?: string } }>;
  };
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) {
    throw new LlmStop('The AI model declined to write this draft');
  }
  const content = choice?.message?.content;
  if (!content) {
    throw new LlmStop('The AI answer did not contain content');
  }

  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(cleaned);
  } catch {
    throw new LlmStop('The AI answer did not contain valid JSON');
  }

  const checked = schema.safeParse(rawJson);
  if (!checked.success) {
    throw new LlmStop('The AI answer did not match the expected format');
  }
  return checked.data;
}

async function generateJsonOpenRouter<S extends z.ZodType>(keys: string[], system: string, prompt: string, schema: S): Promise<z.infer<S>> {
  const ordered = orderedKeysForAttempt(keys);
  let activeModel = env.LLM_MODEL;
  let lastErr: Error | undefined;
  let authFailures = 0;

  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i];
    try {
      return await callOpenRouterWithKey(key, activeModel, system, prompt, schema);
    } catch (e: any) {
      if (e instanceof LlmStop) throw e;
      const status = e?.status as number | undefined;
      if (status === 404) {
        if (activeModel !== 'openrouter/free') {
          log.warn({ model: activeModel }, 'Configured OpenRouter model unavailable (404), falling back to openrouter/free');
          activeModel = 'openrouter/free';
          try {
            return await callOpenRouterWithKey(key, activeModel, system, prompt, schema);
          } catch (fallbackErr: any) {
            if (fallbackErr instanceof LlmStop) throw fallbackErr;
            lastErr = fallbackErr;
            continue;
          }
        }
        throw new LlmStop(`The AI model "${activeModel}" isn’t available on OpenRouter`);
      }
      if (status === 401 || status === 403 || status === 402) {
        authFailures++;
        keyCooldownUntil.set(key, Date.now() + AUTH_OR_QUOTA_COOLDOWN_MS);
        log.warn({ keyIndex: i + 1, totalKeys: ordered.length, status }, 'OpenRouter key rejected or quota exhausted, rotating');
        lastErr = e;
        continue;
      }
      if (status === 429 || (status !== undefined && status >= 500)) {
        keyCooldownUntil.set(key, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        log.warn({ keyIndex: i + 1, totalKeys: ordered.length, status }, 'OpenRouter key rate-limited or unavailable, rotating');
        lastErr = e;
        continue;
      }
      throw e;
    }
  }

  if (authFailures === ordered.length) {
    throw new LlmStop('All configured OpenRouter API keys were rejected or exhausted');
  }
  throw lastErr ?? new Error('All OpenRouter API keys failed');
}

/** Ask the model and get back an object matching `schema`. */
export async function generateJson<S extends z.ZodType>(system: string, prompt: string, schema: S): Promise<z.infer<S>> {
  const openRouterKeys = getOpenRouterKeys();
  if (openRouterKeys.length > 0) {
    return generateJsonOpenRouter(openRouterKeys, system, prompt, schema);
  }

  const model = env.LLM_MODEL;
  const fallback = FALLBACK_MODELS.has(model);
  try {
    const res = await getAnthropicClient().beta.messages.parse({
      model,
      max_tokens: 16000,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal') throw new LlmStop('The AI model declined to write this draft');
    if (res.stop_reason === 'max_tokens') throw new LlmStop('The AI answer was cut off before it finished');
    if (!res.parsed_output) throw new LlmStop('The AI answer did not match the expected format');
    return res.parsed_output as z.infer<S>;
  } catch (e) {
    if (e instanceof LlmStop) throw e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new LlmStop('The AI service rejected the API key');
    }
    if (e instanceof Anthropic.NotFoundError) throw new LlmStop(`The AI model "${model}" isn’t available to this key`);
    if (e instanceof Anthropic.BadRequestError) throw new LlmStop(`The AI service rejected the request: ${e.message}`);
    throw e; // 429 / 5xx / connection: let BullMQ retry later
  }
}
