// Opt-outs (PTC §8.2). One check, used everywhere an email could be stored or exported.
import { Suppression } from '../db/models.js';

/** Of the given emails, the ones that must not be used: the address itself or its whole domain is suppressed. */
export async function suppressedOf(emails: string[]): Promise<Set<string>> {
  const list = emails.map((e) => e.toLowerCase());
  if (!list.length) return new Set();
  const domains = list.map((e) => e.split('@')[1]).filter(Boolean);
  const hits = new Set((await Suppression.find({ value: { $in: [...list, ...domains] } }, { value: 1 }).lean()).map((s) => s.value));
  return new Set(list.filter((e) => hits.has(e) || hits.has(e.split('@')[1])));
}
