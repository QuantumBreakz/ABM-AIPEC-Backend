// Turning messy names and URLs into stable keys, so the same company is recognised across listings and editions.
import { getDomain } from 'tldts';

// Legal-form words that don't tell companies apart. Removed only from the end of a name.
const SUFFIXES = new Set(
  (
    'llc fze fzco fz fzc fzllc dmcc ltd limited inc incorporated corp corporation co company pjsc psc plc gmbh ag sa spa srl ' +
    'bv nv wll llp lp pte pvt private sdn bhd kk as asa ab oy sas sarl est establishment'
  ).split(' '),
);

/** Trim, turn non-breaking spaces into spaces, collapse runs of whitespace. Empty → undefined. */
export function cleanText(s?: string | null): string | undefined {
  const out = s?.replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
  return out || undefined;
}

/** "Siemens Energy L.L.C." and "SIEMENS ENERGY LLC" → "siemens energy". */
export function normalizeName(raw: string): string {
  const base = (cleanText(raw) ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // é → e
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(?<=\b\p{L})\.(?=\p{L}\b)/gu, '') // L.L.C → LLC, S.p.A → SpA
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words.shift();
  while (words.length > 1 && SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

/** Accepts "www.x.com", "x.com/about", "https://x.com". Returns a full https? URL, or undefined if it isn't one. */
export function normalizeUrl(raw?: string | null): string | undefined {
  const s = cleanText(raw);
  if (!s) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return undefined;
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

/** "https://www.shop.example.co.uk/x" → "example.co.uk". IPs and junk → undefined. */
export function normalizeDomain(raw?: string | null): string | undefined {
  const url = normalizeUrl(raw);
  if (!url) return undefined;
  return getDomain(new URL(url).hostname, { allowPrivateDomains: false }) ?? undefined;
}

/** 0..1 word-overlap similarity of two normalised names. Used to flag likely duplicates for review. */
export function nameSimilarity(a: string, b: string): number {
  const A = new Set(normalizeName(a).split(' '));
  const B = new Set(normalizeName(b).split(' '));
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / new Set([...A, ...B]).size || 0;
}
