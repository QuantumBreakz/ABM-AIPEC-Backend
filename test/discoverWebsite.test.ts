import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guard, resetFetcherState } from '../src/lib/fetcher.js';
import {
  buildCandidateDomains,
  discoverOfficialWebsite,
  extractUrlsFromProfileText,
  parseDuckDuckGoResults,
  verifyCandidateWebsite,
} from '../src/sources/discoverWebsite.js';

describe('discoverWebsite', () => {
  it('extracts official URLs and corporate email domains from profile text while ignoring social/free-mail', () => {
    const text =
      'Reach us at sales@apex-valves.ae or visit www.apexvalves.com. Also see https://linkedin.com/company/apex or info@gmail.com.';
    const urls = extractUrlsFromProfileText(text);
    expect(urls).toEqual(['https://www.apexvalves.com', 'https://apex-valves.ae']);
  });

  it('parses DuckDuckGo uddg redirect links and filters aggregator/directory sites', () => {
    const html = `
      <div>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Facme">LinkedIn</a>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Facme-drilling.com%2Fabout">Acme Drilling</a>
        <a class="result__a" href="https://adipec.com/exhibitor/123">ADIPEC</a>
      </div>
    `;
    expect(parseDuckDuckGoResults(html)).toEqual(['https://acme-drilling.com']);
  });

  it('builds up to 4 candidate domains with country TLD support', () => {
    expect(buildCandidateDomains('Apex Drilling Equipment LLC', 'United Arab Emirates')).toEqual([
      'https://apexdrillingequipment.com',
      'https://apex-drilling-equipment.com',
      'https://apexdrillingequipment.ae',
      'https://apex-drilling-equipment.ae',
    ]);
  });

  describe('live local verification & end-to-end discovery', () => {
    let server: http.Server;
    let baseUrl = '';

    beforeAll(async () => {
      guard.allowedIps.add('127.0.0.1');
      server = http.createServer((req, res) => {
        if (req.url === '/robots.txt') {
          res.writeHead(404);
          return res.end();
        }
        if (req.url === '/parked') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html><head><title>Buy this domain - GoDaddy</title></head><body>Domain for sale</body></html>');
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Apex Drilling Systems | Home</title></head><body><h1>Apex Drilling Systems</h1></body></html>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      resetFetcherState();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('verifies matching brand page and rejects parked/mismatched pages', async () => {
      expect(await verifyCandidateWebsite(baseUrl, 'Apex Drilling Systems LLC')).toBe(baseUrl);
      expect(await verifyCandidateWebsite(`${baseUrl}/parked`, 'Apex Drilling Systems LLC')).toBeNull();
      expect(await verifyCandidateWebsite(baseUrl, 'Completely Unrelated Marine Co')).toBeNull();
    });

    it('rejects raw IP addresses as profile URLs for safety', async () => {
      const found = await discoverOfficialWebsite({
        name: 'Apex Drilling Systems LLC',
        country: 'United Arab Emirates',
        description: `Visit our website at ${baseUrl} for catalog details.`,
      });
      expect(found).toBeNull();
    });
  });
});
