/**
 * Reading a company website. Pure functions over HTML (no network), so they're unit tested on saved pages.
 *
 * What we take: a summary, services, markets, short factual sentences (each with its page URL),
 * generic contact details (info@-style only, never personal addresses) and official social links.
 * What we never take: raw HTML, personal emails, anything behind a login.
 */
import * as cheerio from 'cheerio';
import { cleanText, normalizeDomain, normalizeUrl } from '../lib/normalize.js';

export type PageKind = 'home' | 'about' | 'services' | 'markets' | 'contact' | 'news';

const KINDS: [Exclude<PageKind, 'home'>, RegExp][] = [
  ['about', /about|company|who-?we-?are|our-?story|profile|overview|corporate/i],
  ['services', /services?|products?|solutions?|capabilit|what-?we-?do|offerings?|technolog/i],
  ['markets', /industr|markets?|sectors?|applications?/i],
  ['contact', /contact|locations?|offices?|get-?in-?touch/i],
  ['news', /news|media|press|insights?|blog/i],
];
// How many pages of each kind to read (home page is always read on top of these).
const QUOTA: Record<Exclude<PageKind, 'home'>, number> = { about: 1, services: 2, markets: 1, contact: 1, news: 1 };
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i;

export type PageLink = { url: string; kind: Exclude<PageKind, 'home'> };

/** Choose up to ~6 same-site pages worth reading, by URL path first and link text second. */
export function pickPages(html: string, baseUrl: string): PageLink[] {
  const $ = cheerio.load(html);
  const site = normalizeDomain(baseUrl);
  const seen = new Set<string>([stripUrl(baseUrl)]);
  const found: (PageLink & { depth: number })[] = [];
  $('a[href]').each((_, el) => {
    let url: URL;
    try {
      url = new URL($(el).attr('href')!, baseUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || normalizeDomain(url.href) !== site || SKIP_EXT.test(url.pathname)) return;
    const key = stripUrl(url.href);
    if (seen.has(key)) return;
    const text = cleanText($(el).text()) ?? '';
    const kind = KINDS.find(([, re]) => re.test(url.pathname))?.[0] ?? KINDS.find(([, re]) => re.test(text))?.[0];
    if (!kind) return;
    seen.add(key);
    found.push({ url: key, kind, depth: url.pathname.split('/').filter(Boolean).length });
  });
  const out: PageLink[] = [];
  for (const [kind] of KINDS) {
    const best = found.filter((f) => f.kind === kind).sort((a, b) => a.depth - b.depth);
    out.push(...best.slice(0, QUOTA[kind]).map(({ url, kind }) => ({ url, kind })));
  }
  return out;
}

const stripUrl = (u: string) => {
  const url = new URL(u);
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
};

export type ReadPage = {
  url: string;
  title?: string;
  description?: string; // meta / og / JSON-LD description
  paragraphs: string[];
  headings: string[];
  listItems: string[];
  hrefs: string[];
  emails: string[];
  phones: string[];
  addresses: string[];
  sameAs: string[]; // JSON-LD Organization.sameAs (official profiles)
  text: string;
};

const BOILERPLATE = /cookie|privacy|javascript|browser|copyright|all rights reserved|subscribe|newsletter|terms of use|sign in|log ?in/i;
const NAV_WORDS =
  /^(home|read more|learn more|more|contact( us)?|about( us)?|news|careers|search|menu|close|back|next|previous|english|arabic)$/i;

export function readPage(html: string, url: string): ReadPage {
  const $ = cheerio.load(html);
  const hrefs = $('a[href]')
    .map((_, el) => $(el).attr('href'))
    .get()
    .filter(Boolean);
  const mailtos = hrefs.filter((h) => /^mailto:/i.test(h)).map((h) => decodeURIComponent(h.slice(7).split('?')[0]));
  const phones = hrefs.filter((h) => /^tel:/i.test(h)).map((h) => cleanText(decodeURIComponent(h.slice(4)))!);

  // JSON-LD: many sites publish their official description, address and social profiles here.
  const ld: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const v = JSON.parse($(el).text());
      ld.push(...(Array.isArray(v) ? v : v['@graph'] ? v['@graph'] : [v]));
    } catch {
      /* broken JSON-LD is common; ignore it */
    }
  });
  const org = ld.find((x) => /Organization|Corporation|LocalBusiness/i.test(String(x?.['@type'])));
  const addr = org?.address ? [org.address].flat()[0] : undefined;
  const address = addr
    ? cleanText(
        [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.addressCountry?.name ?? addr.addressCountry]
          .filter(Boolean)
          .join(', '),
      )
    : undefined;

  const description =
    cleanText(org?.description) ??
    cleanText($('meta[property="og:description"]').attr('content')) ??
    cleanText($('meta[name="description"]').attr('content'));

  const fullText = cleanText($('body').text()) ?? '';
  $('script, style, noscript, svg, iframe, header, footer, nav, form, [role="navigation"], [aria-hidden="true"]').remove();
  const texts = (sel: string) =>
    $(sel)
      .map((_, el) => cleanText($(el).text()))
      .get()
      .filter((t): t is string => !!t);

  return {
    url,
    title: cleanText($('title').first().text()),
    description,
    paragraphs: texts('p').filter((t) => t.length >= 40 && !BOILERPLATE.test(t)),
    headings: texts('h1, h2, h3, h4').filter((t) => t.length >= 3 && t.length <= 80 && !NAV_WORDS.test(t)),
    listItems: texts('main li, article li, section li, .content li').filter((t) => t.length >= 3 && t.length <= 80 && !NAV_WORDS.test(t)),
    hrefs,
    emails: [...new Set([...mailtos, ...(fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map((e) => e.toLowerCase()))],
    phones: [...new Set(phones)],
    addresses: address ? [address] : [],
    sameAs: [org?.sameAs ?? []].flat().filter((s: unknown) => typeof s === 'string'),
    text: fullText,
  };
}

/** Domain-for-sale and parking pages. */
export function looksParked(p: ReadPage): boolean {
  return /domain (name )?(is|may be) for sale|buy this domain|this domain is parked|parked free|domain parking|hugedomains|sedo\b|dan\.com|afternic/i.test(
    `${p.title ?? ''} ${p.text.slice(0, 3000)}`,
  );
}

// Only shared mailboxes. Personal addresses on a website are not ours to collect here.
const GENERIC_LOCAL =
  /^(info|sales|contact|contacts|enquir(y|ies)|inquir(y|ies)|hello|support|marketing|office|admin|mail|business|service|services|bd|team|general|customer\w*|export|procurement|hr|careers?|jobs|press|media|pr)([._-]\w+)?$/i;

export function genericEmails(emails: string[], domain?: string): string[] {
  return emails.filter((e) => {
    const [local, host] = e.split('@');
    if (!host || /\.(png|jpe?g|gif|svg|webp)$/i.test(host)) return false;
    if (domain && normalizeDomain(host) !== domain) return false;
    return GENERIC_LOCAL.test(local);
  });
}

export type Socials = { linkedin?: string; facebook?: string; instagram?: string; x?: string; youtube?: string };

const SOCIAL: [keyof Socials, RegExp][] = [
  ['linkedin', /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|showcase|school)\/[^/?#]+/i],
  ['facebook', /^https?:\/\/(www\.|m\.)?(facebook|fb)\.com\/(?!sharer|share|dialog|plugins|tr\b|login)[^?#]+/i],
  ['instagram', /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|share)[^/?#]+/i],
  ['x', /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share|home|search|hashtag)[^/?#]+/i],
  ['youtube', /^https?:\/\/(www\.)?youtube\.com\/(channel\/|c\/|user\/|@)[^/?#]+/i],
];

/** Official social profiles from a page's links. Share buttons and post links are ignored. The most-linked one wins. */
export function socialLinks(hrefs: string[]): Socials {
  const counts: Record<string, Map<string, number>> = {};
  for (const h of hrefs) {
    for (const [net, re] of SOCIAL) {
      const m = h.trim().match(re);
      if (!m) continue;
      let url = normalizeUrl(m[0].replace(/^http:/, 'https:').replace(/\/$/, ''));
      if (net === 'linkedin') url = url?.replace(/^https:\/\/[a-z]{2,3}\.linkedin\.com/i, 'https://www.linkedin.com'); // za.linkedin.com → www
      if (!url) continue;
      counts[net] ??= new Map();
      counts[net].set(url, (counts[net].get(url) ?? 0) + 1);
    }
  }
  return Object.fromEntries(Object.entries(counts).map(([net, m]) => [net, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]])) as Socials;
}

/** Sentences that read like plain statements about the company, from one page. */
export function factSentences(p: ReadPage, max = 4): string[] {
  const out: string[] = [];
  for (const para of p.paragraphs) {
    for (const s of para.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      const t = s.trim();
      if (t.length < 50 || t.length > 300 || BOILERPLATE.test(t) || !/[.!?]$/.test(t)) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Cut at a sentence end near `max` characters. */
export function trimText(s: string, max = 600): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

const SECTION_WORDS = /^(our )?(services|products|solutions|industries|markets|sectors|insights|capabilities|applications|what we do)$/i;
const CALL_TO_ACTION = /^(discover|ask|request|get|download|view|see|explore|find|learn|read|contact|book|watch|click|subscribe)\b/i;

/**
 * Turn headings/list items from a services or markets page into a clean list of names:
 * short (≤ 6 words), no "Our range includes:" lead-ins, no buttons, no page titles.
 */
export function offeringNames(items: string[], max: number): string[] {
  const kept = items.filter((t) => t.split(' ').length <= 6 && !/[:?]$/.test(t) && !SECTION_WORDS.test(t) && !CALL_TO_ACTION.test(t));
  return uniqueCi(kept, max);
}

export const uniqueCi = (xs: string[], max: number) => {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, max);
};
