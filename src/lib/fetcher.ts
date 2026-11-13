/**
 * The only way this app touches the outside web. Every step uses it, so the rules live in one place:
 *  - identifies itself with our User-Agent and obeys robots.txt
 *  - one request at a time per website, spaced by FETCH_DELAY_MS
 *  - 15 s timeout, 2 MB max body
 *  - SSRF guard: exhibitor URLs are untrusted, so we refuse private/internal addresses
 *    (otherwise a crafted website URL could reach our Redis or Render's internal network)
 *  - never logs in, never solves captchas; a block is reported as `restricted`
 * Retries are not done here: a retryable FetchError is thrown and BullMQ retries the whole job with backoff.
 */
import dns from 'node:dns';
import net from 'node:net';
import robotsParserModule from 'robots-parser';
import { Agent, fetch } from 'undici';
import { env } from '../env.js';

export type FetchErrorKind =
  | 'robots'
  | 'private_address'
  | 'bad_url'
  | 'too_large'
  | 'timeout'
  | 'network'
  | 'dns'
  | 'http'
  | 'blocked'
  | 'not_json';

export class FetchError extends Error {
  constructor(
    public kind: FetchErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
  /** Worth trying again later (network blip, rate limit, server error). */
  get retryable() {
    return (
      this.kind === 'timeout' || this.kind === 'network' || (this.kind === 'http' && (this.status === 429 || (this.status ?? 0) >= 500))
    );
  }
}

// robots-parser is CommonJS (module.exports = fn) but its types say `export default`; this bridges the two.
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;
type Robots = ReturnType<typeof robotsParser>;

// ---------- SSRF guard ----------
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  blocked.addSubnet(a, p, 'ipv6');

/** Tests add 127.0.0.1 here to reach a local test server. Nothing else should ever touch this. */
export const guard = { allowedIps: new Set<string>() };

/** IPv4-mapped IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1) → the IPv4 inside it. */
function unmapIpv4(ip: string): string | undefined {
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1); // URL normalises the notation
  const m = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return undefined;
  const [hi, lo] = [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

// Note: no ::ffff:0:0/96 rule in the list above. Node's BlockList checks IPv4 addresses against it too,
// which would block every public IPv4. Mapped addresses are unwrapped and checked as IPv4 instead.
export function isPrivateIp(ip: string): boolean {
  if (guard.allowedIps.has(ip)) return false;
  if (net.isIPv6(ip)) {
    const v4 = unmapIpv4(ip);
    return v4 ? isPrivateIp(v4) : blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

// Checked at connect time, so it also covers DNS rebinding and every redirect hop.
const agent = new Agent({
  connect: {
    lookup(hostname: string, options: any, cb: any) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = addresses as unknown as dns.LookupAddress[];
        const bad = list.find((a) => isPrivateIp(a.address));
        if (bad) return cb(new FetchError('private_address', `Refused: ${hostname} resolves to private address ${bad.address}`));
        if (options.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
      });
    },
  },
});

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('bad_url', `Not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('bad_url', `Only http(s) allowed: ${raw}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS lookup, so check them here.
  if (net.isIP(host) && isPrivateIp(host)) throw new FetchError('private_address', `Refused private address ${host}`);
  return u;
}

// ---------- politeness ----------
const nextSlot = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_SLOTS = 500;
const MAX_ROBOTS_CACHE = 300;

/** Reserve the next free time slot for this host, then wait for it. Safe with concurrent callers. */
async function waitTurn(host: string) {
  const now = Date.now();
  if (nextSlot.size > MAX_SLOTS) {
    for (const [k, v] of nextSlot) {
      if (v <= now) nextSlot.delete(k);
    }
  }
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + env.FETCH_DELAY_MS);
  if (at > now) await sleep(at - now);
}

const ROBOTS_TTL = 6 * 60 * 60 * 1000;
const robotsCache = new Map<string, { at: number; robots: Robots | null }>();

async function robotsAllows(u: URL): Promise<boolean> {
  let entry = robotsCache.get(u.origin);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL) {
    const robotsUrl = `${u.origin}/robots.txt`;
    let robots: Robots | null = null;
    try {
      const r = await raw(robotsUrl, 'text/plain', 512 * 1024);
      if (r.status === 200) robots = robotsParser(robotsUrl, r.body);
    } catch {
      // No reachable robots.txt = no rules. (ponytail: Google treats 5xx as "disallow all"; switch if a site complains.)
    }
    if (robotsCache.size >= MAX_ROBOTS_CACHE) {
      const oldest = robotsCache.keys().next().value;
      if (oldest) robotsCache.delete(oldest);
    }
    entry = { at: Date.now(), robots };
    robotsCache.set(u.origin, entry);
  }
  return entry.robots?.isAllowed(u.href, env.SCRAPER_USER_AGENT) ?? true;
}

// ---------- the actual request ----------
export type FetchResult = { url: string; status: number; contentType: string; body: string };

const MAX_REDIRECTS = 5;

async function raw(url: string, accept: string, maxBytes: number): Promise<FetchResult> {
  let current = checkUrl(url);
  for (let hop = 0; ; hop++) {
    await waitTurn(current.host);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(current, {
        dispatcher: agent,
        redirect: 'manual',
        headers: { 'user-agent': env.SCRAPER_USER_AGENT, accept },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e: any) {
      const cause = e?.cause ?? e;
      if (cause instanceof FetchError) throw cause;
      if (e?.name === 'TimeoutError') throw new FetchError('timeout', `Timed out: ${current.href}`);
      // The domain doesn't exist: retrying won't help.
      if (cause?.code === 'ENOTFOUND') throw new FetchError('dns', `Domain not found: ${current.hostname}`);
      throw new FetchError('network', `${cause?.code ?? cause?.message ?? 'Network error'}: ${current.href}`);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new FetchError('http', `Too many redirects: ${url}`, res.status);
      current = checkUrl(new URL(res.headers.get('location')!, current).href);
      continue;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > maxBytes) break; // leaving the loop cancels the download
        chunks.push(chunk);
      }
    }
    if (size > maxBytes) throw new FetchError('too_large', `Bigger than ${maxBytes} bytes: ${current.href}`);
    return {
      url: current.href,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
    };
  }
}

/** Fetch a page or API response. Throws FetchError for robots, private addresses, non-2xx, timeouts. */
export async function fetchPage(url: string, { accept = 'text/html,*/*;q=0.8', maxBytes = 2 * 1024 * 1024 } = {}): Promise<FetchResult> {
  const u = checkUrl(url);
  if (!(await robotsAllows(u))) throw new FetchError('robots', `robots.txt disallows ${u.href}`);
  const r = await raw(u.href, accept, maxBytes);
  if (r.status === 401 || r.status === 403) throw new FetchError('blocked', `Access denied (${r.status}): ${r.url}`, r.status);
  if (r.status < 200 || r.status >= 300) throw new FetchError('http', `HTTP ${r.status}: ${r.url}`, r.status);
  return r;
}

/**
 * Fetch JSON. If the site answers with an HTML page instead (bot protection such as Incapsula does this),
 * that is a block, not a parse error: we report it and never try to get around it (NFR-07).
 */
export async function fetchJson<T>(url: string, opts: { maxBytes?: number } = {}): Promise<T> {
  const r = await fetchPage(url, { accept: 'application/json', maxBytes: opts.maxBytes ?? 5 * 1024 * 1024 });
  if (!r.contentType.includes('json')) {
    if (r.contentType.includes('html'))
      throw new FetchError('blocked', `Got an HTML page instead of data (likely bot protection): ${r.url}`);
    throw new FetchError('not_json', `Expected JSON, got ${r.contentType || 'unknown'}: ${r.url}`);
  }
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new FetchError('not_json', `Invalid JSON from ${r.url}`);
  }
}

/** For tests. */
export function resetFetcherState() {
  nextSlot.clear();
  robotsCache.clear();
}
