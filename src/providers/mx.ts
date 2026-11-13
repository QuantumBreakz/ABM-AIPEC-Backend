/**
 * Free email check: is the address well-formed, and can its domain receive mail at all?
 * It can prove an address is bad, never that it's good, so it only ever answers `invalid` or `unknown`.
 */
import dns from 'node:dns/promises';

export type MxResult = { status: 'invalid' | 'unknown'; note: string };

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DAY = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: MxResult }>();

/** Does `domain` accept mail? MX records, or (per RFC 5321) a plain A/AAAA record. A "null MX" means no. */
async function domainResult(domain: string): Promise<MxResult> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length === 1 && mx[0].exchange === '') return { status: 'invalid', note: 'Domain says it accepts no email (null MX)' };
    if (mx.length) return { status: 'unknown', note: 'Domain accepts email (MX found); the mailbox itself was not checked' };
  } catch (e: any) {
    if (e?.code === 'ENOTFOUND' || e?.code === 'ENXDOMAIN') return { status: 'invalid', note: 'Email domain does not exist' };
    if (e?.code !== 'ENODATA') throw e; // DNS trouble: let the job retry
  }
  const hasAddress = await Promise.any([dns.resolve4(domain), dns.resolve6(domain)]).then(
    (r) => r.length > 0,
    () => false,
  );
  return hasAddress
    ? { status: 'unknown', note: 'Domain has no MX record but has an address; the mailbox was not checked' }
    : { status: 'invalid', note: 'Email domain cannot receive email (no MX or address records)' };
}

export async function checkMx(email: string): Promise<MxResult> {
  if (!SYNTAX.test(email)) return { status: 'invalid', note: 'Not a valid email address' };
  const domain = email.split('@')[1].toLowerCase();
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < DAY) return hit.result;
  const result = await domainResult(domain);
  cache.set(domain, { at: Date.now(), result });
  return result;
}

/** For tests. */
export const clearMxCache = () => cache.clear();
