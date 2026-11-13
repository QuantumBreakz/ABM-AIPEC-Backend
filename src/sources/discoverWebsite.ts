/**
 * Zero-cost, low-memory official website backtracking when an ADIPEC exhibitor profile lacks `WebsiteLink`.
 *
 * Designed for 512 MB Render free-tier workers (pure streaming `undici` + `cheerio` + `node:dns`, 512 KB cap,
 * zero headless browsers):
 *  1. Mine URLs or corporate email domains from the exhibitor's own description text.
 *  2. Query DuckDuckGo HTML (`html.duckduckgo.com`) for "<company> <country> official website".
 *  3. Probe DNS-resolved slug domains (`<slug>.com`, `<slug>.ae`, etc.).
 * Every candidate is fetched (<= 512 KB), checked against `looksParked`, and brand-verified against `companyName`.
 */
import dns from 'node:dns/promises';
import * as cheerio from 'cheerio';
import { fetchPage } from '../lib/fetcher.js';
import { cleanText, nameSimilarity, normalizeDomain, normalizeName, normalizeUrl } from '../lib/normalize.js';
import { looksParked, readPage } from './website.js';

const PROBE_MAX_BYTES = 512 * 1024;

const IGNORED_DOMAINS = new Set([
  'adipec.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'wikipedia.org',
  'wikidata.org',
  'bloomberg.com',
  'dnb.com',
  'zoominfo.com',
  'crunchbase.com',
  'kompass.com',
  'tradewheel.com',
  'europages.com',
  'zaubacorp.com',
  'apollo.io',
  'rocketreach.co',
  'signalhire.com',
  'duckduckgo.com',
  'google.com',
  'bing.com',
]);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'live.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'yandex.com',
  'mail.ru',
  'zoho.com',
]);

const COUNTRY_TLDS: Record<string, string> = {
  'united arab emirates': 'ae',
  uae: 'ae',
  'united kingdom': 'co.uk',
  uk: 'co.uk',
  germany: 'de',
  india: 'in',
  'saudi arabia': 'sa',
  norway: 'no',
  italy: 'it',
  france: 'fr',
};

function isAllowedCandidate(rawUrl: string): string | undefined {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return undefined;
  const domain = normalizeDomain(normalized);
  if (!domain || IGNORED_DOMAINS.has(domain)) return undefined;
  try {
    return new URL(normalized).origin;
  } catch {
    return undefined;
  }
}

/** Tier 1: extract candidate official origins from explicit URLs or corporate emails inside profile text. */
export function extractUrlsFromProfileText(text?: string): string[] {
  if (!text) return [];
  const out = new Set<string>();

  const urlMatches = text.match(/(?:https?:\/\/|www\.)[^\s<>"')]+/gi) ?? [];
  for (const m of urlMatches) {
    const origin = isAllowedCandidate(m.replace(/[.,;:!?]+$/, ''));
    if (origin) out.add(origin);
  }

  const emailMatches = text.matchAll(/\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi);
  for (const m of emailMatches) {
    const domain = m[1]?.toLowerCase();
    if (!domain || FREE_EMAIL_DOMAINS.has(domain) || IGNORED_DOMAINS.has(domain)) continue;
    const origin = isAllowedCandidate(`https://${domain}`);
    if (origin) out.add(origin);
  }

  return [...out].slice(0, 3);
}

/** Tier 2: parse root origins from DuckDuckGo HTML search results. */
export function parseDuckDuckGoResults(html: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();

  $('a.result__a, a.result__url').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let target = href;
    try {
      const u = new URL(href, 'https://html.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) target = uddg;
    } catch {
      return;
    }
    const origin = isAllowedCandidate(target);
    if (origin) out.add(origin);
  });

  return [...out].slice(0, 3);
}

/** Tier 3: build up to 4 clean domain candidates from a company name and optional country. */
export function buildCandidateDomains(name: string, country?: string): string[] {
  const norm = normalizeName(name);
  const words = norm.split(' ').filter((w) => w.length >= 2);
  if (!words.length) return [];

  const compact = words.join('').replace(/[^a-z0-9]/g, '');
  const hyphen = words.join('-').replace(/[^a-z0-9-]/g, '');
  if (compact.length < 3) return [];

  const tlds = ['com'];
  const ccTld = country ? COUNTRY_TLDS[country.trim().toLowerCase()] : undefined;
  if (ccTld) tlds.push(ccTld);

  const out = new Set<string>();
  for (const tld of tlds) {
    out.add(`https://${compact}.${tld}`);
    if (hyphen !== compact) out.add(`https://${hyphen}.${tld}`);
    if (out.size >= 4) break;
  }
  return [...out].slice(0, 4);
}

async function hasDnsRecord(origin: string): Promise<boolean> {
  try {
    const host = new URL(origin).hostname;
    const ips = await dns.resolve4(host);
    return ips.length > 0;
  } catch {
    return false;
  }
}

/** Fetch candidate homepage (<= 512 KB), ensure it isn't parked, and verify brand match. */
export async function verifyCandidateWebsite(candidateOrigin: string, companyName: string): Promise<string | null> {
  try {
    const res = await fetchPage(candidateOrigin, { maxBytes: PROBE_MAX_BYTES });
    if (!res.contentType.includes('html')) return null;

    const page = readPage(res.body, res.url);
    if (looksParked(page)) return null;

    const finalOrigin = new URL(res.url).origin;
    const domain = normalizeDomain(finalOrigin) ?? '';
    const domainLabel = domain.split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
    const companyCompact = normalizeName(companyName).replace(/[^a-z0-9]/g, '');

    const titleAndDesc = cleanText([page.title, page.description].filter(Boolean).join(' ')) ?? '';
    const sim = nameSimilarity(companyName, titleAndDesc);
    const domainMatchesBrand =
      domainLabel.length >= 4 &&
      companyCompact.length >= 4 &&
      (companyCompact.includes(domainLabel) || domainLabel.includes(companyCompact));

    return sim >= 0.4 || domainMatchesBrand ? finalOrigin : null;
  } catch {
    return null;
  }
}

export type DiscoveredWebsite = {
  url: string;
  source: 'profile_text' | 'search' | 'domain_probe';
};

/**
 * Attempt to backtrack an exhibitor's official website using zero-cost, memory-bounded steps.
 * Returns null if no confident official website can be verified.
 */
export async function discoverOfficialWebsite(input: {
  name: string;
  country?: string;
  description?: string;
}): Promise<DiscoveredWebsite | null> {
  // Tier 1: Profile text (zero extra discovery requests)
  for (const candidate of extractUrlsFromProfileText(input.description)) {
    const verified = await verifyCandidateWebsite(candidate, input.name);
    if (verified) return { url: verified, source: 'profile_text' };
  }

  // Tier 2: Free DuckDuckGo HTML search
  try {
    const query = [input.name, input.country, 'official website'].filter(Boolean).join(' ');
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchPage(ddgUrl, { maxBytes: PROBE_MAX_BYTES });
    for (const candidate of parseDuckDuckGoResults(res.body)) {
      const verified = await verifyCandidateWebsite(candidate, input.name);
      if (verified) return { url: verified, source: 'search' };
    }
  } catch {
    // Search rate-limited or unreachable; fall through to DNS domain probe.
  }

  // Tier 3: DNS-first slug domain probe (only fetches HTTP when DNS resolves)
  for (const candidate of buildCandidateDomains(input.name, input.country)) {
    if (!(await hasDnsRecord(candidate))) continue;
    const verified = await verifyCandidateWebsite(candidate, input.name);
    if (verified) return { url: verified, source: 'domain_probe' };
  }

  return null;
}
