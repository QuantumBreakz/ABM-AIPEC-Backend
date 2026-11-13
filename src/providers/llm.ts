/**
 * The AI model (OpenRouter free tier or Anthropic Claude). OFF unless OPENROUTER_API_KEY or LLM_API_KEY is set:
 * without it nothing is generated and drafts stay "pending" (FR-31, zero-new-cost rule).
 *
 * - Structured outputs: the answer must match a zod schema (`messages.parse` or JSON object response), so we never parse free text.
 * - Free tier: OpenRouter free models (e.g. meta-llama/llama-3.3-70b-instruct:free) use OpenAI-compatible chat completions.
 * - Refusals / fallbacks: if the model declines or fails, a clear reason is recorded.
 * - Rate limits: BullMQ retries the job with backoff. The worker is throttled to LLM_RPM requests per minute (pipeline/queue.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { env } from '../env.js';

export const llmEnabled = () => !!(env.OPENROUTER_API_KEY || env.LLM_API_KEY);

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
  client ??= new Anthropic({ apiKey: env.LLM_API_KEY, maxRetries: 2, timeout: 120_000 });
  return client;
};

async function generateJsonOpenRouter<S extends z.ZodType>(apiKey: string, system: string, prompt: string, schema: S): Promise<z.infer<S>> {
  const model = env.LLM_MODEL;
  const url = `${env.LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/QuantumBreakz/ABM-AIPEC-Backend',
      'X-Title': 'ABM-AIPEC Outreach Agent',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `${system}\n\nCRITICAL: Respond ONLY with a raw JSON object matching the requested schema. No code fences (no \`\`\`json), no preamble, no markdown.`,
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LlmStop('The AI service rejected the OpenRouter API key');
    }
    if (response.status === 404) {
      throw new LlmStop(`The AI model "${model}" isn’t available on OpenRouter`);
    }
    const errText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errText}`);
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_err) {
    throw new LlmStop('The AI answer did not contain valid JSON');
  }

  return schema.parse(parsed);
}

/** Ask the model and get back an object matching `schema`. */
export async function generateJson<S extends z.ZodType>(system: string, prompt: string, schema: S): Promise<z.infer<S>> {
  const openRouterKey =
    env.OPENROUTER_API_KEY ||
    (env.LLM_API_KEY?.startsWith('sk-or-') || env.LLM_BASE_URL.includes('openrouter.ai') ? env.LLM_API_KEY : undefined);

  if (openRouterKey) {
    return generateJsonOpenRouter(openRouterKey, system, prompt, schema);
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
