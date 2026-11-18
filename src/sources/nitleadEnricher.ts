/**
 * NitLead (LeadForge) scraping & contact enrichment engine, ported to TypeScript.
 *
 * Cascade (zero API keys required for Steps 1–3; optional paid API fallbacks in Step 4):
 *  1. Browser-realistic safe HTTP fetch (SSRF-guarded on every redirect hop, HTTP/1.1,
 *     automatic insecure-TLS retry for misconfigured cert chains, HTTPS -> HTTP fallback).
 *  2. Homepage scrape (mailto:, tel:, Cloudflare data-cfemail, JSON-LD Person/Organization,
 *     raw HTML email regex, visible text phone regex, leadership/team cards).
 *  3. Proactive contact & team path probing (/contact, /contact-us, /about, /about-us,
 *     /team, /leadership, /management, /get-in-touch, /reach-us, /support, /info).
 *  4. DuckDuckGo OSINT snippet & domain discovery (HTML + Lite fallback, hard 8s timeout):
 *     extracts emails, phones, domain-matched official website, and executive names/titles.
 *  5. Optional Hunter.io / Apollo.io / Snov.io fallbacks (only if API keys are configured).
 *  6. NitLead priority email scorer + contact deduplication.
 */
import dns from 'node:dns';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { parse as parseDomain } from 'tldts';
import { Agent, fetch } from 'undici';
import { env } from '../env.js';
import { isPrivateIp } from '../lib/fetcher.js';
import { cleanText, normalizeDomain, normalizeUrl } from '../lib/normalize.js';

export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/contactus',
  '/contact_us',
  '/about',
  '/about-us',
  '/aboutus',
  '/get-in-touch',
  '/reach-us',
  '/support',
  '/info',
];

export const TEAM_PATHS = [
  '/team',
  '/our-team',
  '/leadership',
  '/management',
  '/about/leadership',
  '/about-us/leadership',
  '/about/team',
  '/people',
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:(?:\(\d{1,4}\)|\d{1,4})[\s.-])?\d{3,4}[\s.-]\d{3,7}(?!\d)/g;

const JUNK_EMAIL_SUFFIXES = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.css',
  '.js',
  '.woff',
  '.woff2',
  '.ttf',
  '.map',
  'w3.org',
  'schema.org',
  'example.com',
  'example.org',
  'example.net',
  'sentry.io',
  'wix.com',
  'wixpress.com',
  'wordpress.com',
  'cloudflare.com',
  'yourdomain.com',
  'domain.com',
  'email.com',
  'test.com',
  'mysite.com',
  'company.com',
  'placeholder.com',
];

const ROBOTIC_LOCAL_RE =
  /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|unsubscribe|bounce|bounces|abuse|dmca|webmaster|hostmaster|root|devnull|null)$/i;

const GENERIC_LOCAL_RE =
  /^(info|sales|contact|contacts|enquir(y|ies)|inquir(y|ies)|hello|hi|hey|support|marketing|office|admin|mail|business|service|services|bd|team|general|customer\w*|export|procurement|hr|careers?|jobs|press|media|pr|reception|bookings?|reservations?|help|helpdesk|billing|accounts?|finance|legal|compliance|operations|ops|projects?|tenders?|rfq|quotes?|commercial|communications?|comm|corporate|feedback|relations?|investor\w*|media\w*|global|middleeast|uae|dubai|abudhabi|mena)([._-][a-z0-9]+)?$/i;

const SKIP_DOMAINS = new Set([
  'google.com',
  'maps.google.com',
  'goo.gl',
  'googleusercontent.com',
  'yelp.com',
  'facebook.com',
  'instagram.com',
  'tripadvisor.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'maps.apple.com',
  'yellowpages.com',
  'bbb.org',
  'foursquare.com',
  'zomato.com',
  'grubhub.com',
  'duckduckgo.com',
  'bing.com',
  'yahoo.com',
  'baidu.com',
  'doordash.com',
  'ubereats.com',
  'deliveroo.com',
  'talabat.com',
  'opentable.com',
  'trustpilot.com',
  'clutch.co',
  'rocketreach.co',
  'zoominfo.com',
  'dnb.com',
  'apollo.io',
  'crunchbase.com',
  'glassdoor.com',
  'indeed.com',
  'mapquest.com',
  'wikipedia.org',
  'wikidata.org',
  'bloomberg.com',
  'adipec.com',
  'kompass.com',
  'signalhire.com',
  'lusha.com',
  'contactout.com',
  'hunter.io',
  'snov.io',
  'leadiq.com',
  'pitchbook.com',
]);

const NAME_STOPWORDS = new Set([
  'the',
  'and',
  'of',
  'for',
  'co',
  'ltd',
  'llc',
  'inc',
  'group',
  'company',
  'corp',
  'corporation',
  'limited',
  'international',
  'global',
  'middle',
  'east',
  'restaurant',
  'cafe',
  'salon',
  'clinic',
  'shop',
  'store',
  'services',
  'service',
  'centre',
  'center',
  'best',
  'new',
  'energy',
  'oil',
  'gas',
  'trading',
  'engineering',
  'industrial',
  'industries',
  'solutions',
  'systems',
  'technologies',
  'technology',
  'general',
  'abu',
  'dhabi',
  'dubai',
  'uae',
]);

const ROLE_TITLE_RE =
  /\b(chief\s+[a-z]+\s+officer|ceo|cfo|coo|cto|cio|cmo|cco|founder|co-founder|managing\s+director|executive\s+director|commercial\s+director|technical\s+director|operations\s+director|sales\s+director|regional\s+director|country\s+director|director|vice\s+president|svp|evp|vp\b|general\s+manager|country\s+manager|regional\s+manager|sales\s+manager|business\s+development\s+manager|marketing\s+manager|operations\s+manager|president|chairman|chairwoman|chairperson|managing\s+partner|partner|head\s+of\s+[a-z][a-z\s&/-]{2,35}|principal)\b/i;

const NOT_A_PERSON_RE =
  /\b(about|contact|home|services?|products?|solutions?|careers?|news|media|blog|privacy|cookie|terms|policy|copyright|rights|reserved|abu\s+dhabi|dubai|saudi|united\s+arab|middle\s+east|oil|gas|energy|company|group|limited|llc|ltd|inc|corp|holdings?|industries|international|engineering|university|chamber|commerce|solutions?|technologies|systems|global|offshore|onshore|drilling|subsea|marine|valve|pipeline|read\s+more|learn\s+more|view\s+all|our\s+team|our\s+leadership|executive\s+team|board\s+of|management\s+team|senior\s+management|meet\s+the|get\s+in\s+touch|send\s+message|head\s+office|branch\s+office|main\s+office)\b/i;

// ---------- SSRF-guarded HTTP agents (HTTP/1.1, plus optional insecure TLS retry) ----------

function ssrfLookup(hostname: string, options: any, cb: any) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad) return cb(new Error(`Refused private address ${bad.address}`));
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const browserAgent = new Agent({
  allowH2: false,
  connect: { lookup: ssrfLookup, timeout: 10_000 },
});

const insecureBrowserAgent = new Agent({
  allowH2: false,
  connect: { lookup: ssrfLookup, rejectUnauthorized: false, timeout: 10_000 },
});

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function checkPublicUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return null;
    return u;
  } catch {
    return null;
  }
}

export type SafeFetchResult = {
  url: string;
  status: number;
  contentType: string;
  body: string;
};

async function fetchOnce(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; insecureTls: boolean; accept: string },
): Promise<SafeFetchResult | null> {
  let current = checkPublicUrl(url);
  if (!current) return null;

  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(current, {
      dispatcher: opts.insecureTls ? insecureBrowserAgent : browserAgent,
      redirect: 'manual',
      headers: {
        'user-agent': CHROME_USER_AGENT,
        accept: opts.accept,
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = checkPublicUrl(new URL(res.headers.get('location')!, current).href);
      if (!current) return null;
      continue;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > opts.maxBytes) break;
        chunks.push(chunk);
      }
    }
    return {
      url: current.href,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
    };
  }
  return null;
}

/**
 * NitLead-style safe browser fetch:
 *  - SSRF-guarded on every redirect hop
 *  - Desktop Chrome headers + HTTP/1.1 (avoids Akamai/WAF HTTP/2 & bot-UA blocks)
 *  - Retries once with relaxed TLS if a corporate site has an incomplete cert chain
 *  - Falls back from https:// to http:// if HTTPS fails completely
 */
export async function safeBrowserFetch(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<SafeFetchResult | null> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const accept = opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const normalized = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;

  try {
    const r = await fetchOnce(normalized, { timeoutMs, maxBytes, insecureTls: false, accept });
    if (r && r.status >= 200 && r.status < 300) return r;
    return r;
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code;
    if (code && TLS_ERROR_CODES.has(String(code))) {
      try {
        return await fetchOnce(normalized, { timeoutMs, maxBytes, insecureTls: true, accept });
      } catch {
        // fall through to http://
      }
    }
    if (normalized.startsWith('https://')) {
      try {
        return await fetchOnce(normalized.replace(/^https:\/\//, 'http://'), { timeoutMs, maxBytes, insecureTls: false, accept });
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------- Pure extraction, validation & scoring helpers ----------

/** Decode Cloudflare's `/cdn-cgi/l/email-protection` hex `data-cfemail` attribute. */
export function decodeCfEmail(hex: string): string | null {
  const cleaned = hex.trim();
  if (cleaned.length < 4 || cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cleaned)) return null;
  const key = Number.parseInt(cleaned.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < cleaned.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(cleaned.slice(i, i + 2), 16) ^ key);
  }
  return cleanEmail(out);
}

/** Validate and normalize an email address, dropping junk/asset/robotic addresses. */
export function cleanEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let email = raw
    .trim()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .replace(/^[<("'`\s]+|[>)"'`.,;:!\s]+$/g, '')
    .toLowerCase();
  // Strip stray leading/trailing non-email characters from text concatenation
  const match = email.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (!match) return null;
  email = match[0].toLowerCase();

  if (email.length > 120) return null;
  if (JUNK_EMAIL_SUFFIXES.some((s) => email.endsWith(s))) return null;
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, host] = parts;
  if (!local || !host?.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  const tld = host.split('.').at(-1) ?? '';
  if (tld.length < 2 || tld.length > 12 || /\d/.test(tld)) return null;
  // Verify real ICANN public suffix (rejects HTML-concatenated junk like info@site.comin or .comfind)
  const parsedHost = parseDomain(host);
  if (!parsedHost.isIcann || !parsedHost.domain) return null;
  if (ROBOTIC_LOCAL_RE.test(local)) return null;
  // Reject hash-like or UUID local parts (e.g. Sentry / tracking ids)
  if (/^[a-f0-9]{20,}$/i.test(local)) return null;
  return email;
}

/** Validate a phone number (7–15 digits, rejects year ranges like 2020-2026). */
export function cleanPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^tel:/i, '').trim();
  const bare = trimmed.replace(/^\(+|\)+$/g, '').trim();
  // Reject year ranges like 2020-2026 or (1999 - 2025)
  if (/^(19|20)\d{2}\s*[-–/]\s*(19|20)\d{2}$/.test(bare)) return null;
  // Reject dotted IP-like numbers (e.g. 192.168.1.1)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  // Reject repeated single digit (e.g. 00000000)
  if (/^(\d)\1{6,}$/.test(digits)) return null;
  return trimmed;
}

/** Prevents assigning an unrelated search result as the business's official website (NitLead rule). */
export function domainMatchesBusiness(url: string, businessName: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  const domain = normalizeDomain(normalized);
  if (!domain || SKIP_DOMAINS.has(domain)) return false;
  const domainCore = (domain.split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
  if (domainCore.length < 3) return false;

  const tokens = businessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  let sig = tokens.filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t));
  if (!sig.length) sig = tokens.filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
  if (!sig.length) sig = tokens.filter((t) => t.length >= 2);
  return sig.some((t) => domainCore.includes(t) || t.includes(domainCore));
}

export function classifyEmailType(email: string): 'generic' | 'business' {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return GENERIC_LOCAL_RE.test(local) ? 'generic' : 'business';
}

/** NitLead `pick_best_email` priority scorer + company domain affinity. */
export function scoreEmail(email: string, companyDomain?: string): number {
  const [local = '', host = ''] = email.toLowerCase().split('@');
  let score = 0;
  const emailDomain = normalizeDomain(host);
  if (companyDomain && emailDomain === companyDomain) score += 120;

  if (/^(info|contact|sales|hello|enquiries|enquiry|inquiry|inquiries|reception|office|admin|business|bd|commercial)$/i.test(local)) {
    score += 100;
  }
  if (/(owner|founder|director|manager|ceo|gm|md|president|vp|chief|partner)/i.test(local)) {
    score += 85;
  }
  if (/^[a-z]{2,15}[._-][a-z]{2,15}$/.test(local)) {
    score += 70; // likely first.last@ person
  } else if (/^[a-z]{3,12}$/.test(local) && !GENERIC_LOCAL_RE.test(local)) {
    score += 45; // likely firstname@ person
  }
  if (/(noreply|no-reply|newsletter|careers|jobs|hr|privacy|legal|support|help|mail)/i.test(local)) {
    score -= 40;
  }
  return score;
}

export function rankEmails(emails: string[], companyDomain?: string): string[] {
  const unique = [...new Set(emails.map((e) => cleanEmail(e)).filter((e): e is string => !!e))];
  return unique.sort((a, b) => scoreEmail(b, companyDomain) - scoreEmail(a, companyDomain));
}

export function extractEmailsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];
  const push = (raw: string | null | undefined) => {
    const cleaned = cleanEmail(raw);
    if (cleaned && !found.includes(cleaned)) found.push(cleaned);
  };

  // 1. Prioritize mailto: links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/^mailto:/i.test(href)) {
      try {
        push(decodeURIComponent(href.slice(7).split('?')[0]));
      } catch {
        push(href.slice(7).split('?')[0]);
      }
    }
  });

  // 2. Cloudflare obfuscated emails
  $('[data-cfemail]').each((_, el) => {
    const hex = $(el).attr('data-cfemail');
    if (hex) push(decodeCfEmail(hex));
  });

  // 3. JSON-LD email & contactPoint.email
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).text());
      const nodes = Array.isArray(raw) ? raw : raw?.['@graph'] ? raw['@graph'] : [raw];
      for (const n of nodes) {
        if (typeof n?.email === 'string') push(n.email);
        const points = Array.isArray(n?.contactPoint) ? n.contactPoint : n?.contactPoint ? [n.contactPoint] : [];
        for (const cp of points) {
          if (typeof cp?.email === 'string') push(cp.email);
        }
      }
    } catch {
      /* ignore invalid JSON-LD */
    }
  });

  // 4. Regex across raw HTML (tags act as clean boundaries) and space-separated text
  for (const m of html.match(EMAIL_RE) ?? []) push(m);
  const spacedText = html.replace(/<[^>]+>/g, ' ');
  for (const m of spacedText.match(EMAIL_RE) ?? []) push(m);

  return found;
}

export function extractPhonesFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];
  const seenDigits = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const cleaned = cleanPhone(raw);
    if (!cleaned) return;
    const digits = cleaned.replace(/\D/g, '');
    if (seenDigits.has(digits)) return;
    seenDigits.add(digits);
    found.push(cleaned);
  };

  // 1. tel: links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/^tel:/i.test(href)) {
      try {
        push(decodeURIComponent(href.slice(4)));
      } catch {
        push(href.slice(4));
      }
    }
  });

  // 2. JSON-LD telephone
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).text());
      const nodes = Array.isArray(raw) ? raw : raw?.['@graph'] ? raw['@graph'] : [raw];
      for (const n of nodes) {
        if (typeof n?.telephone === 'string') push(n.telephone);
        const points = Array.isArray(n?.contactPoint) ? n.contactPoint : n?.contactPoint ? [n.contactPoint] : [];
        for (const cp of points) {
          if (typeof cp?.telephone === 'string') push(cp.telephone);
        }
      }
    } catch {
      /* ignore invalid JSON-LD */
    }
  });

  // 3. Visible text regex (strip scripts/styles first)
  $('script, style, noscript, svg').remove();
  const text = $('body').text();
  for (const m of text.match(PHONE_RE) ?? []) push(m);

  return found.slice(0, 10);
}

// ---------- Named people & decision-maker extraction ----------

export type ScrapedContact = {
  firstName: string;
  lastName: string;
  title?: string;
  seniority?: string;
  profileUrl?: string;
  source: string;
  matchConfidence: 'high' | 'medium' | 'low';
  emails: { address: string; type: 'business' | 'generic'; provider: string }[];
  isGenericInbox?: boolean;
};

function inferSeniority(title?: string): string | undefined {
  if (!title) return undefined;
  if (/\b(ceo|cfo|coo|cto|cio|cmo|cco|chief|founder|co-founder|president|chairman|chairwoman|owner|managing\s+partner)\b/i.test(title))
    return 'CXO';
  if (/\b(vice\s+president|svp|evp|vp)\b/i.test(title)) return 'VP';
  if (/\b(director|head\s+of)\b/i.test(title)) return 'Director';
  if (/\b(manager|lead|principal)\b/i.test(title)) return 'Manager';
  return 'Other';
}

function parsePersonName(raw: string): { firstName: string; lastName: string } | null {
  const cleaned = cleanText(raw)?.replace(/^(Dr\.?|Eng\.?|Mr\.?|Ms\.?|Mrs\.?|Prof\.?)\s+/i, '');
  if (!cleaned || cleaned.length < 4 || cleaned.length > 55) return null;
  if (/[0-9@#$%^&*()=+[\]{}<>/\\|]/.test(cleaned)) return null;
  if (NOT_A_PERSON_RE.test(cleaned)) return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;
  // Each word should look like a capitalized name word (or short connector like "Al", "bin", "de", "van")
  const ok = words.every((w) => /^[A-Z][a-zA-Z'’-]{1,22}$/.test(w) || /^(al|el|bin|ibn|de|van|von|la|da)$/i.test(w));
  if (!ok) return null;
  return { firstName: words[0], lastName: words.slice(1).join(' ') };
}

function normalizeLinkedInPerson(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i);
  if (!m) return undefined;
  return m[0].replace(/^http:/i, 'https:').replace(/^https:\/\/[a-z]{2,3}\.linkedin\.com/i, 'https://www.linkedin.com');
}

/** Extract named decision-makers from JSON-LD Person schemas and team/leadership cards in HTML. */
export function extractPeopleFromHtml(html: string, source: string, companyDomain?: string): ScrapedContact[] {
  const $ = cheerio.load(html);
  const people: ScrapedContact[] = [];
  const seen = new Set<string>();

  const add = (p: ScrapedContact) => {
    const key = `${p.firstName.toLowerCase()} ${p.lastName.toLowerCase()}`;
    if (seen.has(key)) {
      const existing = people.find((x) => `${x.firstName.toLowerCase()} ${x.lastName.toLowerCase()}` === key);
      if (existing) {
        if (!existing.title && p.title) existing.title = p.title;
        if (!existing.profileUrl && p.profileUrl) existing.profileUrl = p.profileUrl;
        for (const e of p.emails) {
          if (!existing.emails.some((x) => x.address === e.address)) existing.emails.push(e);
        }
      }
      return;
    }
    seen.add(key);
    people.push(p);
  };

  // 1. JSON-LD Person / founder / employee / member
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).text());
      const nodes = Array.isArray(raw) ? raw : raw?.['@graph'] ? raw['@graph'] : [raw];
      const candidates: any[] = [];
      for (const n of nodes) {
        if (/Person/i.test(String(n?.['@type']))) candidates.push(n);
        for (const k of ['founder', 'founders', 'employee', 'employees', 'member', 'members']) {
          const v = n?.[k];
          if (Array.isArray(v)) candidates.push(...v);
          else if (v && typeof v === 'object') candidates.push(v);
        }
      }
      for (const c of candidates) {
        const parsed = typeof c?.name === 'string' ? parsePersonName(c.name) : null;
        if (!parsed) continue;
        const title = cleanText(c?.jobTitle);
        const email = cleanEmail(c?.email);
        const sameAs = [c?.sameAs ?? []].flat().find((s: unknown) => typeof s === 'string' && /linkedin\.com\/in\//i.test(s));
        add({
          ...parsed,
          title,
          seniority: inferSeniority(title),
          profileUrl: normalizeLinkedInPerson(typeof sameAs === 'string' ? sameAs : undefined),
          source,
          matchConfidence: 'high',
          emails: email ? [{ address: email, type: classifyEmailType(email), provider: source }] : [],
        });
      }
    } catch {
      /* ignore invalid JSON-LD */
    }
  });

  // 2. Team / leadership cards in DOM
  $(
    'article, li, [class*="team"], [class*="leader"], [class*="member"], [class*="person"], [class*="staff"], [class*="exec"], [class*="director"], [class*="board"], [class*="card"]',
  ).each((_, el) => {
    const $el = $(el);
    const cardText = cleanText($el.text()) ?? '';
    if (cardText.length < 10 || cardText.length > 420) return;
    if (!ROLE_TITLE_RE.test(cardText)) return;

    // Look for name in heading or strong tag inside the card
    const nameEl = $el.find('h2, h3, h4, h5, strong, [class*="name"]').first();
    const parsed = parsePersonName(nameEl.text());
    if (!parsed) return;

    // Find the title text (short text matching ROLE_TITLE_RE that isn't the name itself)
    let title: string | undefined;
    $el.find('p, span, div, h4, h5, h6, small').each((__, tEl) => {
      if (title) return;
      const t = cleanText($(tEl).text());
      if (!t || t.length < 3 || t.length > 80) return;
      if (t.toLowerCase().includes(`${parsed.firstName} ${parsed.lastName}`.toLowerCase())) return;
      if (ROLE_TITLE_RE.test(t)) title = t;
    });
    if (!title) {
      const m = cardText.match(ROLE_TITLE_RE);
      if (m) title = m[0];
    }
    if (!title) return;

    const cardEmails: ScrapedContact['emails'] = [];
    $el.find('a[href^="mailto:"]').each((__, a) => {
      const email = cleanEmail($(a).attr('href'));
      if (email && !cardEmails.some((e) => e.address === email)) {
        cardEmails.push({ address: email, type: classifyEmailType(email), provider: source });
      }
    });
    let profileUrl: string | undefined;
    $el.find('a[href*="linkedin.com/in/"]').each((__, a) => {
      if (!profileUrl) profileUrl = normalizeLinkedInPerson($(a).attr('href'));
    });

    add({
      ...parsed,
      title,
      seniority: inferSeniority(title),
      profileUrl,
      source,
      matchConfidence: 'medium',
      emails: cardEmails,
    });
  });

  // 3. Derive named contacts from personal work emails (first.last@companyDomain) found on the page
  if (companyDomain) {
    const pageEmails = extractEmailsFromHtml(html);
    for (const email of pageEmails) {
      if (classifyEmailType(email) !== 'business') continue;
      if (normalizeDomain(email.split('@')[1]) !== companyDomain) continue;
      if (people.some((p) => p.emails.some((e) => e.address === email))) continue;
      const local = email.split('@')[0];
      const parts = local.split(/[._-]/).filter(Boolean);
      if (parts.length === 2 && parts.every((w) => /^[a-z]{2,18}$/.test(w)) && !GENERIC_LOCAL_RE.test(parts[0])) {
        const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
        const candidate = parsePersonName(`${cap(parts[0])} ${cap(parts[1])}`);
        if (candidate) {
          add({
            ...candidate,
            source,
            matchConfidence: 'medium',
            emails: [{ address: email, type: 'business', provider: source }],
          });
        }
      }
    }
  }

  return people.slice(0, 12);
}

/** Label a company/department inbox cleanly as a Contact when no named person owns it. */
export function buildCompanyInboxContact(
  emails: { address: string; type: 'business' | 'generic'; provider: string }[],
): ScrapedContact | null {
  if (!emails.length) return null;
  const primary = emails[0].address;
  const local = primary.split('@')[0]?.toLowerCase() ?? 'info';
  let firstName = 'General';
  let lastName = 'Inquiries';
  let title = 'Company Contact';
  if (/^sales|bd|commercial|business|export|quotes?|rfq|tenders?/.test(local)) {
    firstName = 'Sales';
    lastName = 'Team';
    title = 'Sales & Business Development';
  } else if (/^marketing|media|pr|press|comm/.test(local)) {
    firstName = 'Marketing';
    lastName = 'Team';
    title = 'Marketing & Communications';
  } else if (/^support|help|service|customer/.test(local)) {
    firstName = 'Support';
    lastName = 'Team';
    title = 'Customer Support';
  } else if (/^procurement|purchasing/.test(local)) {
    firstName = 'Procurement';
    lastName = 'Team';
    title = 'Procurement';
  } else if (/^office|reception|admin|contact/.test(local)) {
    firstName = 'Company';
    lastName = 'Contact';
    title = 'Main Office Contact';
  }
  return {
    firstName,
    lastName,
    title,
    source: emails[0].provider,
    matchConfidence: 'medium',
    emails,
    isGenericInbox: true,
  };
}

// ---------- DuckDuckGo OSINT (NitLead FastEnricher Steps 1 & 5) ----------

type SearchHit = { title: string; snippet: string; url: string };

export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];

  // html.duckduckgo.com format
  $('.result, .web-result').each((_, el) => {
    const a = $(el).find('a.result__a').first();
    const rawHref = a.attr('href');
    if (!rawHref) return;
    let url = rawHref;
    try {
      const u = new URL(rawHref, 'https://html.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) url = uddg;
    } catch {
      return;
    }
    const title = cleanText(a.text()) ?? '';
    const snippet = cleanText($(el).find('.result__snippet').text()) ?? '';
    if (title || snippet) hits.push({ title, snippet, url });
  });

  if (hits.length) return hits.slice(0, 10);

  // lite.duckduckgo.com format fallback
  $('a.result-link').each((_, el) => {
    const rawHref = $(el).attr('href');
    if (!rawHref) return;
    let url = rawHref;
    try {
      const u = new URL(rawHref, 'https://lite.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) url = uddg;
    } catch {
      return;
    }
    const title = cleanText($(el).text()) ?? '';
    const snippet = cleanText($(el).closest('tr').next('tr').text()) ?? '';
    if (title || snippet) hits.push({ title, snippet, url });
  });

  return hits.slice(0, 10);
}

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  if (env.NODE_ENV === 'test') return [];
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await safeBrowserFetch(url, { timeoutMs: 8_000, maxBytes: 512 * 1024 });
      if (res?.status !== 200) continue;
      // If DDG shows a bot/anomaly challenge, try the next endpoint
      if (/anomaly-modal|bot\s+check|verify\s+you\s+are\s+human/i.test(res.body)) continue;
      const hits = parseDuckDuckGoHtml(res.body);
      if (hits.length) return hits;
    } catch {
      /* move to fallback */
    }
  }
  return [];
}

/** Extract high-confidence executive contacts from search snippets (e.g. LinkedIn / press hits). */
export function extractPeopleFromSnippets(hits: SearchHit[], companyName: string): ScrapedContact[] {
  const people: ScrapedContact[] = [];
  const seen = new Set<string>();
  const companyTokens = companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));

  for (const h of hits) {
    const combined = `${h.title} ${h.snippet}`;
    const lower = combined.toLowerCase();
    // Require the snippet/title to actually reference this company
    if (companyTokens.length && !companyTokens.some((t) => lower.includes(t))) continue;

    // Pattern 1: LinkedIn profile title "First Last - Title - Company | LinkedIn"
    const liUrl = normalizeLinkedInPerson(h.url);
    if (liUrl) {
      const segments = h.title
        .replace(/\s*\|\s*LinkedIn.*$/i, '')
        .split(/\s+[-–|]\s+/)
        .map((s) => s.trim());
      if (segments.length >= 2) {
        const parsed = parsePersonName(segments[0]);
        const title = segments[1];
        if (parsed && ROLE_TITLE_RE.test(title)) {
          const key = `${parsed.firstName.toLowerCase()} ${parsed.lastName.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            people.push({
              ...parsed,
              title: title.slice(0, 80),
              seniority: inferSeniority(title),
              profileUrl: liUrl,
              source: 'ddg_osint',
              matchConfidence: 'medium',
              emails: [],
            });
          }
        }
      }
      continue;
    }

    // Pattern 2: "First Last, CEO of ..." or "CEO First Last"
    const m = combined.match(
      /\b([A-Z][a-z]{2,18}\s+[A-Z][a-z]{2,18})(?:,\s*|\s+[-–]\s+)((?:Chief\s+[A-Za-z]+\s+Officer|CEO|Managing\s+Director|Founder|Co-Founder|President|Chairman|General\s+Manager|Vice\s+President|Director)(?:\s+of\s+[A-Za-z\s&]{2,25})?)\b/,
    );
    if (m) {
      const parsed = parsePersonName(m[1]);
      const title = cleanText(m[2]);
      if (parsed && title) {
        const key = `${parsed.firstName.toLowerCase()} ${parsed.lastName.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          people.push({
            ...parsed,
            title: title.slice(0, 80),
            seniority: inferSeniority(title),
            source: 'ddg_osint',
            matchConfidence: 'low',
            emails: [],
          });
        }
      }
    }
  }
  return people.slice(0, 5);
}

// ---------- Optional Paid Providers (NitLead EmailFinder Section 4.2) ----------

async function hunterDomainSearch(domain: string): Promise<{ email: string; firstName?: string; lastName?: string; title?: string }[]> {
  if (!env.HUNTER_API_KEY || env.NODE_ENV === 'test') return [];
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${encodeURIComponent(env.HUNTER_API_KEY)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: { emails?: { value?: string; first_name?: string; last_name?: string; position?: string; confidence?: number }[] };
    };
    return (data.data?.emails ?? [])
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .map((e) => ({
        email: cleanEmail(e.value) ?? '',
        firstName: e.first_name ?? undefined,
        lastName: e.last_name ?? undefined,
        title: e.position ?? undefined,
      }))
      .filter((e) => !!e.email);
  } catch {
    return [];
  }
}

async function apolloPeopleSearch(name: string, country?: string): Promise<ScrapedContact[]> {
  if (!env.APOLLO_API_KEY || env.NODE_ENV === 'test') return [];
  try {
    const orgRes = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.APOLLO_API_KEY },
      body: JSON.stringify({
        q_organization_name: name,
        ...(country ? { organization_locations: [country] } : {}),
        per_page: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!orgRes.ok) return [];
    const orgData = (await orgRes.json()) as { organizations?: { id?: string }[] };
    const orgId = orgData.organizations?.[0]?.id;
    if (!orgId) return [];

    const pplRes = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.APOLLO_API_KEY },
      body: JSON.stringify({
        organization_ids: [orgId],
        person_titles: ['owner', 'founder', 'ceo', 'managing director', 'director', 'manager'],
        per_page: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!pplRes.ok) return [];
    const pplData = (await pplRes.json()) as {
      people?: { first_name?: string; last_name?: string; title?: string; email?: string; linkedin_url?: string }[];
    };
    const out: ScrapedContact[] = [];
    for (const p of pplData.people ?? []) {
      if (!p.first_name || !p.last_name) continue;
      const email = cleanEmail(p.email);
      out.push({
        firstName: p.first_name.trim(),
        lastName: p.last_name.trim(),
        title: p.title ?? undefined,
        seniority: inferSeniority(p.title),
        profileUrl: normalizeLinkedInPerson(p.linkedin_url),
        source: 'apollo',
        matchConfidence: 'high',
        emails: email ? [{ address: email, type: classifyEmailType(email), provider: 'apollo' }] : [],
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function snovDomainSearch(domain: string): Promise<string[]> {
  if (!env.SNOV_CLIENT_ID || !env.SNOV_CLIENT_SECRET || env.NODE_ENV === 'test') return [];
  try {
    const tokRes = await fetch('https://api.snov.io/v1/get-access-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: env.SNOV_CLIENT_ID,
        client_secret: env.SNOV_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokRes.ok) return [];
    const tokData = (await tokRes.json()) as { access_token?: string };
    if (!tokData.access_token) return [];

    const res = await fetch('https://api.snov.io/v1/get-emails-from-domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokData.access_token}` },
      body: JSON.stringify({ domain, type: 'all', limit: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { emails?: { email?: string }[] };
    return (data.emails ?? []).map((e) => cleanEmail(e.email)).filter((e): e is string => !!e);
  } catch {
    return [];
  }
}

// ---------- Main NitLead 5-Step Enrichment Cascade ----------

export type EnrichmentInput = {
  name: string;
  country?: string;
  domain?: string;
  websiteUrl?: string;
  existingEmails?: string[];
  existingPhones?: string[];
};

export type EnrichmentResult = {
  websiteUrl?: string;
  domain?: string;
  emails: { address: string; type: 'business' | 'generic'; provider: string }[];
  phones: string[];
  contacts: ScrapedContact[];
  pagesScraped: number;
  sourcesUsed: string[];
};

/** Discover same-site contact/about/team links from a homepage HTML. */
function discoverContactAndTeamUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const site = normalizeDomain(baseUrl);
  const found: string[] = [];
  const seen = new Set<string>();
  const priorityRe = /contact|reach-?us|get-?in-?touch|team|leadership|management|executive|people|board|about|support|office|location/i;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || normalizeDomain(u.href) !== site) return;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) return;
    const text = cleanText($(el).text()) ?? '';
    if (!priorityRe.test(u.pathname) && !priorityRe.test(text)) return;
    u.hash = '';
    u.search = '';
    const clean = u.href.replace(/\/$/, '');
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push(clean);
    }
  });
  return found;
}

/**
 * Run the full NitLead scraping & contact enrichment cascade for one company.
 * Designed to stay fast (bounded concurrent probes, early exits, hard timeouts) while maximizing hit rate.
 */
export async function enrichCompanyWithNitLead(input: EnrichmentInput): Promise<EnrichmentResult> {
  const emailProvider = new Map<string, string>();
  const phones = new Set<string>();
  const people: ScrapedContact[] = [];
  const sourcesUsed = new Set<string>();
  let pagesScraped = 0;

  let websiteUrl = input.websiteUrl;
  let domain = input.domain ?? (websiteUrl ? normalizeDomain(websiteUrl) : undefined);

  const addEmail = (raw: string, provider: string) => {
    const cleaned = cleanEmail(raw);
    if (!cleaned) return;
    if (!emailProvider.has(cleaned)) emailProvider.set(cleaned, provider);
  };
  const addPhone = (raw: string) => {
    const cleaned = cleanPhone(raw);
    if (cleaned) phones.add(cleaned);
  };
  const mergePeople = (incoming: ScrapedContact[]) => {
    for (const p of incoming) {
      const key = `${p.firstName.toLowerCase()} ${p.lastName.toLowerCase()}`;
      const existing = people.find((x) => `${x.firstName.toLowerCase()} ${x.lastName.toLowerCase()}` === key);
      if (existing) {
        if (!existing.title && p.title) existing.title = p.title;
        if (!existing.seniority && p.seniority) existing.seniority = p.seniority;
        if (!existing.profileUrl && p.profileUrl) existing.profileUrl = p.profileUrl;
        for (const e of p.emails) {
          if (!existing.emails.some((x) => x.address === e.address)) existing.emails.push(e);
        }
      } else {
        people.push(p);
      }
      for (const e of p.emails) addEmail(e.address, e.provider);
    }
  };

  for (const e of input.existingEmails ?? []) addEmail(e, 'website');
  for (const p of input.existingPhones ?? []) addPhone(p);

  const scrapeSite = async (startUrl: string) => {
    const visited = new Set<string>();
    const home = await safeBrowserFetch(startUrl, { timeoutMs: 12_000 });
    if (!home || home.status < 200 || home.status >= 300 || !home.contentType.includes('html')) return false;

    sourcesUsed.add('website');
    pagesScraped++;
    websiteUrl = home.url;
    domain = domain ?? normalizeDomain(home.url);
    visited.add(home.url.replace(/\/$/, ''));

    for (const e of extractEmailsFromHtml(home.body)) addEmail(e, 'website');
    for (const p of extractPhonesFromHtml(home.body)) addPhone(p);
    mergePeople(extractPeopleFromHtml(home.body, 'website', domain));

    // Step 2: Combine discovered links + NitLead CONTACT_PATHS + TEAM_PATHS
    const origin = new URL(home.url).origin;
    const discovered = discoverContactAndTeamUrls(home.body, home.url);
    const probeUrls = [...discovered, ...CONTACT_PATHS.map((p) => `${origin}${p}`), ...TEAM_PATHS.map((p) => `${origin}${p}`)].filter(
      (u) => {
        const k = u.replace(/\/$/, '');
        if (visited.has(k)) return false;
        visited.add(k);
        return true;
      },
    );

    // Probe in small concurrent batches of 3 (max 10 probes) so it finishes in a few seconds
    const maxProbes = 10;
    const targets = probeUrls.slice(0, maxProbes);
    for (let i = 0; i < targets.length; i += 3) {
      // Early exit if we already have at least 1 company-domain email AND at least 1 named contact
      const hasDomainEmail = [...emailProvider.keys()].some((e) => !domain || normalizeDomain(e.split('@')[1]) === domain);
      if (hasDomainEmail && people.length >= 2) break;

      const batch = targets.slice(i, i + 3);
      const results = await Promise.all(batch.map((u) => safeBrowserFetch(u, { timeoutMs: 8_000 })));
      for (const r of results) {
        if (!r || r.status < 200 || r.status >= 300 || !r.contentType.includes('html')) continue;
        pagesScraped++;
        for (const e of extractEmailsFromHtml(r.body)) addEmail(e, 'website');
        for (const p of extractPhonesFromHtml(r.body)) addPhone(p);
        mergePeople(extractPeopleFromHtml(r.body, 'website', domain));
      }
    }
    return true;
  };

  // Step 1 & 2: Direct website scrape + contact/team path probing
  let siteWorked = false;
  if (websiteUrl) {
    siteWorked = await scrapeSite(websiteUrl);
  }

  // Step 3: DuckDuckGo OSINT fallback (runs if site missing/failed, no emails yet, or no named people yet)
  const needsEmail = emailProvider.size === 0;
  const needsPeople = people.length === 0;
  const needsSite = !websiteUrl;

  if (needsSite || !siteWorked || needsEmail || needsPeople) {
    const emailQuery = domain
      ? `"@${domain}" OR "${input.name}" ${input.country ?? ''} email contact`.trim()
      : `"${input.name}" ${input.country ?? ''} email contact`.trim();

    const hits = await searchDuckDuckGo(emailQuery);
    if (hits.length) {
      sourcesUsed.add('ddg_osint');
      for (const h of hits) {
        const text = `${h.title} ${h.snippet}`;
        for (const m of text.match(EMAIL_RE) ?? []) {
          const cleaned = cleanEmail(m);
          if (!cleaned) continue;
          // Accept if it matches company domain, or if the snippet clearly matches the company
          if (
            !domain ||
            normalizeDomain(cleaned.split('@')[1]) === domain ||
            domainMatchesBusiness(`https://${cleaned.split('@')[1]}`, input.name)
          ) {
            addEmail(cleaned, 'ddg_osint');
          }
        }
        for (const m of text.match(PHONE_RE) ?? []) addPhone(m);

        // Adopt official website if we didn't have one
        if (!websiteUrl && domainMatchesBusiness(h.url, input.name)) {
          const norm = normalizeUrl(h.url);
          if (norm) {
            websiteUrl = new URL(norm).origin;
            domain = normalizeDomain(websiteUrl);
          }
        }
      }
      mergePeople(extractPeopleFromSnippets(hits, input.name));

      // If DDG just discovered the company's website, scrape it too!
      if (needsSite && websiteUrl && !siteWorked) {
        await scrapeSite(websiteUrl);
      }
    }

    // Second DDG pass: broader contact/phone search if still no email, OR leadership search if still no people
    if (emailProvider.size === 0) {
      const fallbackHits = await searchDuckDuckGo(`"${input.name}" ${input.country ?? ''} contact phone email`.trim());
      if (fallbackHits.length) {
        sourcesUsed.add('ddg_osint');
        for (const h of fallbackHits) {
          const text = `${h.title} ${h.snippet}`;
          for (const m of text.match(EMAIL_RE) ?? []) addEmail(m, 'ddg_osint');
          for (const m of text.match(PHONE_RE) ?? []) addPhone(m);
        }
        mergePeople(extractPeopleFromSnippets(fallbackHits, input.name));
      }
    } else if (people.length === 0) {
      const leaderHits = await searchDuckDuckGo(`"${input.name}" CEO OR "Managing Director" OR Founder OR Director`.trim());
      if (leaderHits.length) {
        sourcesUsed.add('ddg_osint');
        mergePeople(extractPeopleFromSnippets(leaderHits, input.name));
      }
    }
  }

  // Step 4: Optional Paid API Fallbacks (Hunter -> Apollo -> Snov, only when keys configured)
  if (emailProvider.size === 0 && domain) {
    const hunterHits = await hunterDomainSearch(domain);
    if (hunterHits.length) {
      sourcesUsed.add('hunter');
      for (const h of hunterHits) {
        addEmail(h.email, 'hunter');
        if (h.firstName && h.lastName) {
          mergePeople([
            {
              firstName: h.firstName,
              lastName: h.lastName,
              title: h.title,
              seniority: inferSeniority(h.title),
              source: 'hunter',
              matchConfidence: 'high',
              emails: [{ address: h.email, type: classifyEmailType(h.email), provider: 'hunter' }],
            },
          ]);
        }
      }
    }
  }

  if ((emailProvider.size === 0 || people.length === 0) && env.APOLLO_API_KEY) {
    const apolloContacts = await apolloPeopleSearch(input.name, input.country);
    if (apolloContacts.length) {
      sourcesUsed.add('apollo');
      mergePeople(apolloContacts);
    }
  }

  if (emailProvider.size === 0 && domain) {
    const snovEmails = await snovDomainSearch(domain);
    if (snovEmails.length) {
      sourcesUsed.add('snov');
      for (const e of snovEmails) addEmail(e, 'snov');
    }
  }

  // Step 5: Rank emails via NitLead scorer and assemble final contact list
  const rankedAddresses = rankEmails([...emailProvider.keys()], domain);
  const rankedEmails = rankedAddresses.map((address) => ({
    address,
    type: classifyEmailType(address),
    provider: emailProvider.get(address) ?? 'website',
  }));

  // Any top company/inbox emails not already attached to a named contact -> create a clean company contact
  const assignedEmails = new Set(people.flatMap((p) => p.emails.map((e) => e.address)));
  const unassigned = rankedEmails.filter((e) => !assignedEmails.has(e.address)).slice(0, 3);
  const contacts: ScrapedContact[] = [...people];
  const inboxContact = buildCompanyInboxContact(unassigned);
  if (inboxContact) contacts.push(inboxContact);

  return {
    websiteUrl,
    domain,
    emails: rankedEmails,
    phones: [...phones].slice(0, 10),
    contacts,
    pagesScraped,
    sourcesUsed: [...sourcesUsed],
  };
}
