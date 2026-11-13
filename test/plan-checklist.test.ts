/**
 * The "done when" items from PLAN.md that weren't covered elsewhere, one block per ticket.
 * If one fails, that ticket isn't done any more.
 */
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    resolveMx: vi.fn(async () => [{ exchange: 'mx.example', priority: 10 }]),
    resolve4: vi.fn(async () => ['192.0.2.1']),
    resolve6: vi.fn(async () => []),
  },
}));

const { app } = await import('../src/app.js');
const { Company, Contact, Event, ExportLog, Run, Suppression, Usage, User } = await import('../src/db/models.js');
const { env } = await import('../src/env.js');
const { closeQueues, drainAll } = await import('../src/pipeline/queue.js');
await import('../src/pipeline/index.js');
const { cronTasks } = await import('../src/routes/system.js');
const { verificationStep } = await import('../src/pipeline/steps/verification.js');
const { factSentences, pickPages, readPage, socialLinks, genericEmails } = await import('../src/sources/website.js');

const site = (name: string) => readFileSync(new URL(`./fixtures/${name}/home.html`, import.meta.url), 'utf8');
const job = (data: object) => ({ data }) as Job;
const text = (res: request.Response) => res.text;
let admin: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await User.create({ email: 'admin@example.com', role: 'admin', passwordHash: await bcrypt.hash('password-123', 4) });
  admin = request.agent(app);
  await admin.post('/auth/login').send({ email: 'admin@example.com', password: 'password-123' }).expect(200);
  await Event.create({
    edition: 2026,
    name: 'ADIPEC 2026',
    directoryUrl: 'https://www.adipec.com/exhibition/exhibitor-list/',
    advertisedCount: 2260,
  });
});
afterEach(() => {
  env.MILLIONVERIFIER_API_KEY = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('BE-0.1 errors never leak a stack trace in production', () => {
  it('500 says "Something went wrong" and nothing else', async () => {
    vi.resetModules();
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { errorHandler } = await import('../src/lib/errors.js');
    process.env.NODE_ENV = old;
    const sent: { status?: number; body?: unknown } = {};
    const res: any = {
      status(s: number) {
        sent.status = s;
        return res;
      },
      json(b: unknown) {
        sent.body = b;
        return res;
      },
    };
    errorHandler(new Error('db password is hunter2\n    at secret.ts:1'), { log: { error() {} } } as never, res, () => {});
    expect(sent).toEqual({ status: 500, body: { error: { code: 'internal', message: 'Something went wrong' } } });
  });
});

describe('BE-2.1 / 2.2 website extraction on differently built sites', () => {
  it('site 2: no structured data, other page names, partner link next to its own', () => {
    const base = 'https://www.samplevalves.example/';
    const kinds = pickPages(site('site2'), base).map((p) => `${p.kind}:${new URL(p.url).pathname}`);
    expect(kinds).toEqual([
      'about:/company-profile',
      'services:/solutions',
      'services:/products/valves',
      'markets:/sectors',
      'contact:/get-in-touch',
      'news:/press',
    ]);
    const page = readPage(site('site2'), base);
    expect(page.description).toBe('Sample Valves designs invented flow-control valves for refineries and pipelines.');
    // The company's own profile is linked twice, the partner once: the most-linked one wins.
    expect(socialLinks(page.hrefs)).toEqual({
      linkedin: 'https://www.linkedin.com/company/sample-valves',
      youtube: 'https://www.youtube.com/channel/UCsamplevalves',
    });
    expect(genericEmails(page.emails, 'samplevalves.example')).toEqual(['sales@samplevalves.example']); // not the personal one
  });

  it('site 3: one page, no metadata, no links', () => {
    const page = readPage(site('site3'), 'https://democoatings.example/');
    expect(page.description).toBeUndefined();
    expect(pickPages(site('site3'), 'https://democoatings.example/')).toEqual([]);
    expect(factSentences(page)).toEqual([
      'Demo Coatings applies invented anti-corrosion coatings to offshore structures in the North Sea.',
      'The company was founded in 1998 and operates two coating yards in Aberdeen.',
    ]);
  });
});

describe('BE-2.6 weekly website refresh', () => {
  it('queues only websites last read over 30 days ago, and not ones being read now', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await Company.create([
      {
        name: 'Old Site',
        normalizedName: 'old site',
        website: { url: 'https://old.example/' },
        stages: { website: { status: 'completed', updatedAt: old } },
      },
      {
        name: 'Fresh Site',
        normalizedName: 'fresh site',
        website: { url: 'https://fresh.example/' },
        stages: { website: { status: 'completed', updatedAt: new Date() } },
      },
      {
        name: 'Busy Site',
        normalizedName: 'busy site',
        website: { url: 'https://busy.example/' },
        stages: { website: { status: 'in_progress', updatedAt: old } },
      },
    ]);
    expect(await cronTasks['refresh-websites']()).toEqual({ queued: 1 });
    expect((await Company.findOne({ name: 'Old Site' }).lean())?.stages?.website?.status).toBe('in_progress');
  });
});

describe('BE-3.2 contact import at scale', () => {
  it('100 rows with 5 bad ones: 95 created, 5 reported; re-import adds nothing', async () => {
    const c = await Company.create({ name: 'Import Co', normalizedName: 'import co', editions: [{ edition: 2026, sourceId: 'imp' }] });
    const rows = Array.from({ length: 100 }, (_, i) =>
      i % 20 === 7 ? `,Missing${i},CTO,,` : `Person${i},Example,Role ${i},https://www.linkedin.com/in/p${i},p${i}@import.example`,
    );
    const csv = ['first_name,last_name,title,profile_url,email', ...rows].join('\n');
    const r = (await admin.post(`/companies/${c._id}/contacts/import`).send({ csv }).expect(200)).body;
    expect([r.created, r.updated, r.errors.length]).toEqual([95, 0, 5]);
    const again = (await admin.post(`/companies/${c._id}/contacts/import`).send({ csv }).expect(200)).body;
    expect([again.created, again.updated]).toEqual([0, 0]);
    expect(await Contact.countDocuments({ company: c._id })).toBe(95);
  });
});

describe('Phase 5–6 checks', () => {
  let companyId = '';
  let contactId = '';
  beforeAll(async () => {
    const c = await Company.create({ name: 'Check Co', normalizedName: 'check co', editions: [{ edition: 2026, sourceId: 'chk' }] });
    companyId = String(c._id);
    const p = await Contact.create({
      company: c._id,
      firstName: 'Ana',
      lastName: 'Check',
      source: 'manual',
      emails: [
        { address: 'a1@check.example', type: 'business' },
        { address: 'a2@check.example', type: 'business' },
        {
          address: 'old@check.example',
          type: 'business',
          verification: { status: 'unknown', checkedAt: new Date(Date.now() - 45 * 864e5), source: 'mx-check' },
        },
        {
          address: 'recent@check.example',
          type: 'business',
          verification: { status: 'invalid', checkedAt: new Date(), source: 'mx-check' },
        },
      ],
    });
    contactId = String(p._id);
  });

  it('BE-5.2 MillionVerifier stops at the monthly cap and leaves the rest not_checked', async () => {
    await Usage.deleteMany({});
    env.MILLIONVERIFIER_API_KEY = 'mv';
    const old = env.MILLIONVERIFIER_MAX_CHECKS;
    env.MILLIONVERIFIER_MAX_CHECKS = 1;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ result: 'ok', error: '' })));
    await verificationStep(job({ companyId }));
    env.MILLIONVERIFIER_MAX_CHECKS = old;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const statuses = (await Contact.findById(contactId).lean())!.emails.map((e) => e.verification?.status);
    expect(statuses.filter((s) => s === 'verified')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'not_checked')).toHaveLength(1);
    expect((await Company.findById(companyId).lean())?.stages?.verification).toMatchObject({
      status: 'pending_access',
      reason: expect.stringContaining('Monthly MillionVerifier limit reached (1 checks)'),
    });
  });

  it('BE-5.3 re-checks results older than 30 days, leaves recent ones alone', async () => {
    await verificationStep(job({ companyId })); // free MX check now
    const by = Object.fromEntries((await Contact.findById(contactId).lean())!.emails.map((e) => [e.address, e.verification]));
    expect(by['old@check.example']?.checkedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000); // re-checked
    expect(by['recent@check.example']).toMatchObject({ status: 'invalid' }); // untouched
    expect(Object.values(by).every((v) => v?.status !== 'not_checked')).toBe(true);
  });

  it('BE-5.4 the export log shows initial → (check) → final', async () => {
    await ExportLog.deleteMany({});
    await admin.get('/exports/outreach.csv?version=initial').expect(200);
    await admin.get('/exports/outreach.csv?version=final').expect(200);
    const log = (await admin.get('/exports/log')).body.items.map((e: { version: string }) => e.version);
    expect(log).toEqual(['final', 'initial']); // newest first
  });

  it('BE-6.4 deleting a contact removes them from every export', async () => {
    const before = text(await admin.get('/exports/contacts.csv?version=final'));
    expect(before).toContain('Ana');
    await admin.delete(`/contacts/${contactId}`).expect(204);
    for (const kind of ['contacts', 'outreach'])
      expect(text(await admin.get(`/exports/${kind}.csv?version=final`))).not.toContain('a1@check.example');
    expect(await Contact.exists({ _id: contactId })).toBeNull();
  });

  it('BE-6.1 gap report totals add up', async () => {
    await Suppression.deleteMany({});
    const r = (await admin.get('/reports/gap?edition=2026').expect(200)).body;
    const companies = await Company.countDocuments({ 'editions.edition': 2026 });
    for (const step of Object.keys(r.byStep)) {
      const sum = Object.values(r.byStep[step] as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(sum).toBe(companies); // every company is in exactly one status per step
    }
    const o = (await admin.get('/stats/overview?edition=2026')).body;
    expect(o.unique + o.duplicates).toBe(r.discovered); // every listing is either unique or a duplicate
    await Run.deleteMany({});
  });
});
