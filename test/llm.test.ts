import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from '../src/env.js';
import { generateJson, getOpenRouterKeys, LlmStop, llmEnabled, resetLlmRotation } from '../src/providers/llm.js';

const TestSchema = z.object({ ok: z.boolean(), note: z.string() });

function clearAllLlmEnv() {
  env.OPENROUTER_API_KEY = undefined;
  env.OPENROUTER_API_KEY_1 = undefined;
  env.OPENROUTER_API_KEY_2 = undefined;
  env.OPENROUTER_API_KEY_3 = undefined;
  env.OPENROUTER_API_KEYS = undefined;
  env.LLM_API_KEY = undefined;
  resetLlmRotation();
}

describe('OpenRouter 3-key rotation', () => {
  afterEach(() => {
    clearAllLlmEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('collects and deduplicates keys from OPENROUTER_API_KEY_1..3 and comma-separated vars', () => {
    clearAllLlmEnv();
    expect(llmEnabled()).toBe(false);
    expect(getOpenRouterKeys()).toEqual([]);

    env.OPENROUTER_API_KEY_1 = ' sk-or-v1-key1 ';
    env.OPENROUTER_API_KEY_2 = 'sk-or-v1-key2';
    env.OPENROUTER_API_KEY_3 = 'sk-or-v1-key3';
    env.OPENROUTER_API_KEYS = 'sk-or-v1-key1, , sk-or-v1-key2';

    expect(llmEnabled()).toBe(true);
    expect(getOpenRouterKeys()).toEqual(['sk-or-v1-key1', 'sk-or-v1-key2', 'sk-or-v1-key3']);
  });

  it('rotates round-robin across 3 keys on consecutive requests', async () => {
    clearAllLlmEnv();
    env.OPENROUTER_API_KEY_1 = 'sk-or-v1-k1';
    env.OPENROUTER_API_KEY_2 = 'sk-or-v1-k2';
    env.OPENROUTER_API_KEY_3 = 'sk-or-v1-k3';

    const usedAuthHeaders: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        usedAuthHeaders.push(auth);
        return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true,"note":"hi"}\n```' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await generateJson('sys', 'p1', TestSchema);
    await generateJson('sys', 'p2', TestSchema);
    await generateJson('sys', 'p3', TestSchema);
    await generateJson('sys', 'p4', TestSchema);

    expect(usedAuthHeaders).toEqual(['Bearer sk-or-v1-k1', 'Bearer sk-or-v1-k2', 'Bearer sk-or-v1-k3', 'Bearer sk-or-v1-k1']);
  });

  it('fails over to the next key on 429 rate limit and skips cooled-down key next call', async () => {
    clearAllLlmEnv();
    env.OPENROUTER_API_KEY_1 = 'sk-or-v1-k1';
    env.OPENROUTER_API_KEY_2 = 'sk-or-v1-k2';
    env.OPENROUTER_API_KEY_3 = 'sk-or-v1-k3';

    const usedKeys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
        usedKeys.push(auth);
        if (auth === 'Bearer sk-or-v1-k1') {
          return new Response('rate limited', { status: 429 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"note":"ok"}' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const r1 = await generateJson('sys', 'p1', TestSchema);
    expect(r1).toEqual({ ok: true, note: 'ok' });

    const r2 = await generateJson('sys', 'p2', TestSchema);
    expect(r2).toEqual({ ok: true, note: 'ok' });

    // Call 1 tried k1 (429) -> rotated immediately to k2 (200).
    // Call 2 skipped cooled-down k1 and used k2/k3 directly without hitting k1 again.
    expect(usedKeys).toEqual(['Bearer sk-or-v1-k1', 'Bearer sk-or-v1-k2', 'Bearer sk-or-v1-k2']);
  });

  it('throws LlmStop if all keys are rejected (401/403/402) and throws retryable Error if all 429', async () => {
    clearAllLlmEnv();
    env.OPENROUTER_API_KEY_1 = 'sk-or-v1-k1';
    env.OPENROUTER_API_KEY_2 = 'sk-or-v1-k2';
    env.OPENROUTER_API_KEY_3 = 'sk-or-v1-k3';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    await expect(generateJson('sys', 'p', TestSchema)).rejects.toBeInstanceOf(LlmStop);

    resetLlmRotation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limit', { status: 429 })),
    );
    await expect(generateJson('sys', 'p', TestSchema)).rejects.toThrow(/OpenRouter API error \(429\)/);
  });

  it('throws LlmStop when JSON does not match schema', async () => {
    clearAllLlmEnv();
    env.OPENROUTER_API_KEY_1 = 'sk-or-v1-k1';

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '{"wrong":123}' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(generateJson('sys', 'p', TestSchema)).rejects.toBeInstanceOf(LlmStop);
  });
});
