import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FetchError, fetchJson, fetchPage, guard, isPrivateIp, resetFetcherState } from '../src/lib/fetcher.js';

let base = '';
const hits: number[] = [];
const server = http.createServer((req, res) => {
  hits.push(Date.now());
  const routes: Record<string, () => void> = {
    '/robots.txt': () => res.end('User-agent: *\nDisallow: /private/'),
    '/ok': () => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>hi</h1>'),
    '/json': () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}'),
    '/html-instead-of-json': () => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Incapsula</html>'),
    '/big': () => res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(5000)),
    '/to-metadata': () => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    '/to-ok': () => res.writeHead(301, { location: '/ok' }).end(),
    '/forbidden': () => res.writeHead(403).end(),
    '/busy': () => res.writeHead(503).end(),
    '/private/secret': () => res.end('should never be fetched'),
  };
  (routes[req.url ?? ''] ?? (() => res.writeHead(404).end()))();
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  guard.allowedIps.add('127.0.0.1'); // only our test server; every other private address stays blocked
});
afterAll(() => {
  guard.allowedIps.clear();
  server.close();
});
beforeEach(() => resetFetcherState());

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FetchError ? e.kind : `other: ${e}`;
  }
};

describe('SSRF guard', () => {
  it.each(['127.0.0.2', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:10.0.0.1'])(
    'blocks %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    },
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
  it('refuses private IP literals and non-http schemes', async () => {
    expect(await kindOf(fetchPage('http://10.0.0.1/'))).toBe('private_address');
    expect(await kindOf(fetchPage('http://[::1]/'))).toBe('private_address');
    expect(await kindOf(fetchPage('file:///etc/passwd'))).toBe('bad_url');
  });
  it('refuses a redirect into a private address', async () => {
    expect(await kindOf(fetchPage(`${base}/to-metadata`))).toBe('private_address');
  });
});

describe('fetching', () => {
  it('follows normal redirects', async () => {
    const r = await fetchPage(`${base}/to-ok`);
    expect(r.url).toBe(`${base}/ok`);
    expect(r.body).toContain('hi');
  });
  it('obeys robots.txt', async () => {
    expect(await kindOf(fetchPage(`${base}/private/secret`))).toBe('robots');
  });
  it('caps the body size', async () => {
    expect(await kindOf(fetchPage(`${base}/big`, { maxBytes: 1000 }))).toBe('too_large');
  });
  it('parses JSON and reports an HTML answer as a block, not a parse error', async () => {
    expect(await fetchJson(`${base}/json`)).toEqual({ a: 1 });
    expect(await kindOf(fetchJson(`${base}/html-instead-of-json`))).toBe('blocked');
  });
  it('marks 403 as blocked (not retryable) and 503 as retryable', async () => {
    const forbidden = await fetchPage(`${base}/forbidden`).catch((e) => e);
    const busy = await fetchPage(`${base}/busy`).catch((e) => e);
    expect([forbidden.kind, forbidden.retryable]).toEqual(['blocked', false]);
    expect([busy.kind, busy.retryable]).toEqual(['http', true]);
  });
  it('spaces out requests to the same host', async () => {
    const { env } = await import('../src/env.js');
    const old = env.FETCH_DELAY_MS;
    env.FETCH_DELAY_MS = 150;
    hits.length = 0;
    await Promise.all([fetchPage(`${base}/ok`), fetchPage(`${base}/ok`), fetchPage(`${base}/ok`)]);
    env.FETCH_DELAY_MS = old;
    const pageHits = hits.slice(-3);
    expect(pageHits[2] - pageHits[0]).toBeGreaterThanOrEqual(280);
  });
});
