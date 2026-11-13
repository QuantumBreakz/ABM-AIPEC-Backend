import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Company } from '../src/db/models.js';
import { guard, resetFetcherState } from '../src/lib/fetcher.js';
import { closeQueues, drainAll } from '../src/pipeline/queue.js';
import { websiteStep } from '../src/pipeline/steps/website.js';
import {
  factSentences,
  genericEmails,
  looksParked,
  offeringNames,
  pickPages,
  readPage,
  socialLinks,
  trimText,
} from '../src/sources/website.js';

const page = (name: string) => readFileSync(new URL(`./fixtures/site/${name}.html`, import.meta.url), 'utf8');
const BASE = 'https://www.exampledrilling.example/';

describe('website parsing', () => {
  it('picks key same-site pages and skips files and other sites', () => {
    const picked = pickPages(page('home'), BASE);
    expect(picked).toEqual([
      { url: 'https://www.exampledrilling.example/about-us', kind: 'about' },
      { url: 'https://www.exampledrilling.example/services', kind: 'services' },
      { url: 'https://www.exampledrilling.example/industries', kind: 'markets' },
      { url: 'https://www.exampledrilling.example/contact', kind: 'contact' },
      { url: 'https://www.exampledrilling.example/news', kind: 'news' },
    ]);
  });

  it('reads description, JSON-LD address and profiles, and drops cookie boilerplate', () => {
    const p = readPage(page('home'), BASE);
    expect(p.description).toBe('Example Drilling provides invented onshore drilling services across the Gulf.');
    expect(p.addresses).toEqual(['Example Tower 1, Abu Dhabi, AE']);
    expect(p.sameAs).toContain('https://www.linkedin.com/company/example-drilling/');
    expect(p.paragraphs.some((x) => /cookies/.test(x))).toBe(false);
    expect(p.phones).toEqual(['+971 2 000 0000']);
  });

  it('keeps only shared mailboxes, never personal addresses', () => {
    const emails = [...readPage(page('home'), BASE).emails, ...readPage(page('contact'), BASE).emails];
    expect(genericEmails(emails, 'exampledrilling.example').sort()).toEqual([
      'careers@exampledrilling.example',
      'info@exampledrilling.example',
      'sales@exampledrilling.example',
    ]);
    expect(genericEmails(['info@gmail.com'], 'exampledrilling.example')).toEqual([]); // other domain
    expect(genericEmails(['logo@2x.png'])).toEqual([]);
  });

  it('finds official social profiles and ignores share buttons', () => {
    const p = readPage(page('home'), BASE);
    expect(socialLinks([...p.hrefs, ...p.sameAs])).toEqual({
      linkedin: 'https://www.linkedin.com/company/example-drilling',
      youtube: 'https://www.youtube.com/@exampledrilling',
      x: 'https://x.com/exampledrilling',
    });
  });

  it('extracts plain factual sentences', () => {
    expect(factSentences(readPage(page('about'), BASE))).toEqual([
      'Example Drilling was founded in Abu Dhabi in 1999 and now employs 800 invented people.',
      'The company focuses on onshore drilling and workover services.',
      'Our safety record is industry leading, with zero lost-time incidents in 2025.',
    ]);
  });

  it('cleans offering lists: no lead-ins, buttons, page titles or long sentences', () => {
    expect(
      offeringNames(
        [
          'Services',
          'Our range of valves includes:',
          'Ask a demo',
          'Advanced Valve Solutions',
          'Innovation lies at the heart of the Paltech brand',
          'advanced valve solutions',
        ],
        10,
      ),
    ).toEqual(['Advanced Valve Solutions']);
    expect(socialLinks(['https://za.linkedin.com/company/2roads']).linkedin).toBe('https://www.linkedin.com/company/2roads');
  });

  it('spots parked domains and trims long text at a sentence', () => {
    expect(looksParked(readPage(page('parked'), BASE))).toBe(true);
    expect(looksParked(readPage(page('home'), BASE))).toBe(false);
    expect(trimText('One sentence here. Two sentence here. Three.', 30)).toBe('One sentence here.');
  });
});

// ---------- the step, against a local web server ----------
let base = '';
const routes: Record<string, () => [number, string, string?]> = {
  '/robots.txt': () => [200, 'User-agent: *\nDisallow: /private', 'text/plain'],
  '/': () => [200, page('home')],
  '/about-us': () => [200, page('about')],
  '/services': () => [200, page('services')],
  '/industries': () => [200, page('industries')],
  '/contact': () => [200, page('contact')],
  '/news': () => [500, 'oops'],
  '/parked': () => [200, page('parked')],
};
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').replace(/\/$/, '') || '/';
  const [status, body, type] = routes[path]?.() ?? [404, 'not found'];
  res.writeHead(status, { 'content-type': type ?? 'text/html' }).end(body);
});
const job = (companyId: unknown) => ({ data: { companyId: String(companyId) } }) as Job;
const make = (name: string, url?: string, extra: object = {}) =>
  Company.create({ name, normalizedName: name.toLowerCase(), website: url ? { url } : {}, ...extra });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  guard.allowedIps.add('127.0.0.1');
  resetFetcherState();
});
afterAll(async () => {
  guard.allowedIps.clear();
  server.close();
  await drainAll();
  await closeQueues();
});

describe('website step', () => {
  it('reads the site, saves sourced research, and hands the company to Sales Navigator review', async () => {
    const c = await make('Example Drilling', `${base}/`);
    await websiteStep(job(c._id));
    const after = (await Company.findById(c._id).lean())!;

    expect(after.stages?.website).toMatchObject({ status: 'partial', reason: '1 of 6 pages couldn’t be read' });
    expect(after.website?.summary).toBe('Example Drilling provides invented onshore drilling services across the Gulf.');
    expect(after.website?.services).toEqual(['Onshore drilling', 'Workover services', 'Rig moves', 'Well testing']);
    expect(after.website?.markets).toEqual(['Oil and gas', 'Geothermal']);
    expect(after.website?.facts?.length).toBeGreaterThanOrEqual(4);
    for (const f of after.website!.facts!) expect(f.sourceUrl).toMatch(/^http:\/\/127\.0\.0\.1/);
    expect(after.website?.contactDetails?.emails?.sort()).toEqual([
      'careers@exampledrilling.example',
      'info@exampledrilling.example',
      'sales@exampledrilling.example',
    ]);
    expect(after.website?.skipped).toEqual([{ url: `${base}/news`, reason: 'The website answered HTTP 500' }]);
    expect(after.website?.pagesReviewed).toHaveLength(5);
    expect(after.socials).toMatchObject({
      linkedin: 'https://www.linkedin.com/company/example-drilling',
      x: 'https://x.com/exampledrilling',
    });
    expect(after.stages?.social?.status).toBe('completed');
    expect(after.stages?.account).toMatchObject({ status: 'pending_access', reason: 'Waiting for Sales Navigator review' });
    expect(after.stages?.people?.status).toBe('pending_access');
  });

  it('never overwrites a field a person edited', async () => {
    const c = await make('Locked Co', `${base}/`, {
      website: { url: `${base}/`, summary: 'Human summary' },
      lockedFields: ['website.summary'],
    });
    await websiteStep(job(c._id));
    expect((await Company.findById(c._id).lean())?.website?.summary).toBe('Human summary');
  });

  it('sends a company with no website to review, and keeps profile socials', async () => {
    const c = await make('No Site Co', undefined, { socials: { linkedin: 'https://www.linkedin.com/company/no-site' } });
    await websiteStep(job(c._id));
    const after = (await Company.findById(c._id).lean())!;
    expect(after.stages?.website?.status).toBe('needs_review');
    expect(after.stages?.social).toMatchObject({ status: 'completed', reason: 'From the ADIPEC profile' });
  });

  it('fails a parked site and a domain that does not exist, with reasons', async () => {
    const parked = await make('Parked Co', `${base}/parked`);
    await websiteStep(job(parked._id));
    expect((await Company.findById(parked._id).lean())?.stages?.website).toMatchObject({
      status: 'failed',
      reason: 'The website looks parked or for sale',
    });

    const gone = await make('Gone Co', 'https://does-not-exist.invalid/');
    await websiteStep(job(gone._id));
    expect((await Company.findById(gone._id).lean())?.stages?.website).toMatchObject({
      status: 'failed',
      reason: 'The website’s domain doesn’t exist',
    });
  });

  it('respects robots.txt', async () => {
    const c = await make('Private Co', `${base}/private`);
    await websiteStep(job(c._id));
    expect((await Company.findById(c._id).lean())?.stages?.website?.status).toBe('restricted');
  });
});
