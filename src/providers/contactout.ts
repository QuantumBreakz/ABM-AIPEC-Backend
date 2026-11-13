/**
 * ContactOut: work email for a LinkedIn profile. OFF unless CONTACTOUT_API_KEY is set (zero-new-cost rule).
 *
 * API used: GET https://api.contactout.com/v1/people/linkedin?profile=<url>&email_type=work, header `token`.
 *  - 200 → profile.work_email[] (+ profile.work_email_status{email: "Verified" | "Unverified"})
 *  - 404 → nothing found (no credit used)
 *  - 400 bad key · 401 bad input · 403 out of credits / no access · 429 rate limited (retry-after)
 * We deliberately don't use their v2 batch endpoint: it "guesses" work emails, and the PTC forbids guessed emails.
 *
 * Every lookup takes one unit from a hard monthly cap (CONTACTOUT_MAX_LOOKUPS), tracked in Mongo,
 * so a bug or a big run can't spend more than the cap.
 */
import { Usage } from '../db/models.js';
import { env } from '../env.js';

export const contactoutEnabled = () => !!env.CONTACTOUT_API_KEY;

/** Stops the email step and is shown to the reviewer. */
export class ProviderStop extends Error {}

const LINKEDIN_PROFILE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|pub)\//i;
export const isLinkedInProfile = (url?: string | null) => !!url && LINKEDIN_PROFILE.test(url);

/** Take one lookup from this month's budget. False = budget used up. */
export async function takeLookup(): Promise<boolean> {
  const max = env.CONTACTOUT_MAX_LOOKUPS;
  if (max <= 0) return false;
  const period = new Date().toISOString().slice(0, 7);
  try {
    const doc = await Usage.findOneAndUpdate(
      { provider: 'contactout', period, count: { $lt: max } },
      { $inc: { count: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return !!doc;
  } catch (e: any) {
    if (e?.code === 11000) return false; // this month's doc exists and is at the cap, so the upsert collided
    throw e;
  }
}

export type FoundEmail = { address: string; status?: string };

/** Work emails for one LinkedIn profile, or [] if ContactOut has none. Throws ProviderStop when we must stop. */
export async function lookupWorkEmails(profileUrl: string): Promise<FoundEmail[]> {
  const url = `https://api.contactout.com/v1/people/linkedin?profile=${encodeURIComponent(profileUrl)}&email_type=work`;
  const res = await fetch(url, {
    headers: { token: env.CONTACTOUT_API_KEY!, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return [];
  if (res.status === 400) throw new ProviderStop('ContactOut rejected the API key');
  if (res.status === 401) return []; // ContactOut says our input was bad: treat as not found for this person
  if (res.status === 403) {
    const text = await res.text();
    throw new ProviderStop(/credit/i.test(text) ? 'ContactOut is out of credits' : 'This ContactOut key has no access to email lookup');
  }
  if (!res.ok) throw new Error(`ContactOut answered HTTP ${res.status}`); // 429 / 5xx: BullMQ retries later
  const body = (await res.json()) as { profile?: { work_email?: string[]; work_email_status?: Record<string, string> } };
  const statuses = body.profile?.work_email_status ?? {};
  return (body.profile?.work_email ?? []).map((a) => ({ address: a.trim().toLowerCase(), status: statuses[a] }));
}
