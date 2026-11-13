/**
 * The AI model (Claude, via Anthropic's SDK). OFF unless LLM_API_KEY is set: without it nothing is generated
 * and drafts stay "pending" (FR-31, zero-new-cost rule).
 *
 * - Structured outputs: the answer must match a zod schema (`messages.parse`), so we never parse free text.
 * - Refusals: on models that support it, a declined request is retried server-side on Anthropic's recommended
 *   fallback model (`fallbacks: "default"`); if the whole chain declines we stop with a clear reason.
 * - Rate limits / outages: thrown as-is, so BullMQ retries the job with backoff. The worker is also
 *   throttled to LLM_RPM requests per minute (pipeline/queue.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { env } from '../env.js';

export const llmEnabled = () => !!env.LLM_API_KEY;

/** Reasons shown on a draft that wasn't (or isn't yet) written. */
export const AI_REASON = {
  generating: 'Generating a new draft…',
  noModel: 'No language model is available, so no draft was generated.',
  noFactsCompany: 'No sourced company fact is available to cite, so no draft was written.',
  noFactsContact: 'Not enough sourced facts about this company.',
};

/** Stops this draft and becomes its reason (not retried). */
export class LlmStop extends Error {}

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

let client: Anthropic | undefined;
const getClient = () => {
  client ??= new Anthropic({ apiKey: env.LLM_API_KEY, maxRetries: 2, timeout: 120_000 });
  return client;
};

/** Ask the model and get back an object matching `schema`. */
export async function generateJson<S extends z.ZodType>(system: string, prompt: string, schema: S): Promise<z.infer<S>> {
  const model = env.LLM_MODEL;
  const fallback = FALLBACK_MODELS.has(model);
  try {
    const res = await getClient().beta.messages.parse({
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
