/**
 * MillionVerifier: real mailbox check, one credit per email. OFF unless MILLIONVERIFIER_API_KEY is set.
 * API: GET https://api.millionverifier.com/api/v3/?api=<key>&email=<email>&timeout=<s>
 *   → { result: "ok" | "catch_all" | "unknown" | "invalid" | "disposable", subresult, error: "" | message, ... }
 * Hard monthly cap: MILLIONVERIFIER_MAX_CHECKS.
 */
import type { EmailStatus } from '../contract.js';
import { env } from '../env.js';
import { takeUsage } from './usage.js';

export const millionVerifierEnabled = () => !!env.MILLIONVERIFIER_API_KEY;
export const takeCheck = () => takeUsage('millionverifier', env.MILLIONVERIFIER_MAX_CHECKS);

/** Stops the verification step and is shown to the reviewer. */
export class VerifierStop extends Error {}

// Their result → our status (PTC §4.2). Catch-all and disposable can't be trusted to deliver: "risky".
const MAP: Record<string, EmailStatus> = {
  ok: 'verified',
  invalid: 'invalid',
  catch_all: 'risky',
  disposable: 'risky',
  unknown: 'unknown',
};

export async function verifyEmail(email: string): Promise<{ status: EmailStatus; note: string }> {
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(env.MILLIONVERIFIER_API_KEY!)}&email=${encodeURIComponent(email)}&timeout=20`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`MillionVerifier answered HTTP ${res.status}`); // BullMQ retries
  const body = (await res.json()) as { result?: string; subresult?: string; error?: string };
  if (body.error) {
    if (/credit/i.test(body.error)) throw new VerifierStop('MillionVerifier is out of credits');
    if (/api ?key|apikey/i.test(body.error)) throw new VerifierStop('MillionVerifier rejected the API key');
    if (/ip/i.test(body.error)) throw new VerifierStop('MillionVerifier blocked this server’s IP address');
    throw new Error(`MillionVerifier error: ${body.error}`);
  }
  const status = MAP[body.result ?? ''] ?? 'unknown';
  return { status, note: [body.result, body.subresult].filter(Boolean).join(' / ') };
}
