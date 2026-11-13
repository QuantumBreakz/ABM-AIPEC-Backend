/** AI review, exports, email verification and the gap report, through the API (Phases 4–6). */
import bcrypt from 'bcryptjs';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// DNS for the free MX check: "good.example" accepts mail, "nomail.example" doesn't exist.
vi.mock('node:dns/promises', () => ({
  default: {
    resolveMx: vi.fn(async (d: string) => {
      if (d === 'good.example') return [{ exchange: 'mx.good.example', priority: 10 }];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    }),
    resolve4: vi.fn(async () => {
      throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    }),
    resolve6: vi.fn(async () => {
      throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    }),
  },
}));

const { app } = await import('../src/app.js');
const { Company, Contact, Event, ExportLog, Run, Suppression, User } = await import('../src/db/models.js');
const { env } = await import('../src/env.js');
const { closeQueues, drainAll } = await import('../src/pipeline/queue.js');
await import('../src/pipeline/index.js'); // registers the step handlers (no workers start)
const { verificationStep } = await import('../src/pipeline/steps/verification.js');
const { clearMxCache } = await import('../src/providers/mx.js');

let admin: ReturnType<typeof request.agent>;
let companyId = '';
let bareId = '';
let samId = '';
const job = (data: object) => ({ data }) as Job;

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
  const [c, bare] = await Company.create([
    {
      name: 'Example Drilling',
      normalizedName: 'example drilling',
      domain: 'good.example',
      editions: [
        {
          edition: 2026,
          sourceId: '1',
          profileUrl: 'https://www.adipec.com/x?id=1',
          country: 'United Arab Emirates',
          description: '=HYPERLINK("evil")',
        },
      ],
      website: {
        url: 'https://good.example/',
        summary: 'Drilling, "the good kind", in the Gulf',
        facts: [{ text: 'Runs rigs.', sourceUrl: 'https://good.example/about', kind: 'fact' }],
      },
      stages: { website: { status: 'completed' }, account: { status: 'pending_access', reason: 'Waiting for Sales Navigator review' } },
      ai: {
        status: 'draft',
        summary: 'Live draft summary',
        hyperPersonalization: 'Live draft opener',
        versions: [{ fields: { summary: 'Live draft summary', hyperPersonalization: 'Live draft opener' }, by: 'ai', at: new Date() }],
      },
    },
    {
      name: 'Bare Co',
      normalizedName: 'bare co',
      editions: [{ edition: 2026, sourceId: '2' }],
      stages: { website: { status: 'failed', reason: 'Domain gone' } },
    },
  ]);
  companyId = String(c._id);
  bareId = String(bare._id);
  const sam = await Contact.create({
    company: c._id,
    firstName: 'Sam',
    lastName: 'Example',
    source: 'manual',
    emails: [
      { address: 'sam@good.example', type: 'business' },
      { address: 'sam@nomail.example', type: 'business' },
      { address: 'x@optout.example', type: 'business' },
    ],
    ai: {
      status: 'draft',
      subject: 'Hello',
      draft: 'Draft body',
      versions: [{ fields: { subject: 'Hello', draft: 'Draft body', linkedinDraft: '' }, by: 'ai', at: new Date() }],
    },
  });
  samId = String(sam._id);
  await Company.updateOne({ _id: c._id }, { contactsCount: 1, emailStatuses: ['not_checked'] });
  await Suppression.create({ value: 'optout.example' });
});
afterEach(() => {
  env.LLM_API_KEY = undefined;
  env.MILLIONVERIFIER_API_KEY = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('AI review', () => {
  it('regenerate without a model keeps it pending and says why', async () => {
    expect((await admin.post(`/companies/${companyId}/ai/regenerate`).expect(202)).body).toEqual({ queued: true });
    const c = (await admin.get(`/companies/${companyId}`)).body;
    expect(c.ai).toMatchObject({ status: 'pending', reason: 'No language model is available, so no draft was generated.' });
  });

  it('with a model, regenerate queues a job and shows "generating"', async () => {
    env.LLM_API_KEY = 'test';
    await admin.post(`/companies/${companyId}/ai/regenerate`).expect(202);
    const c = (await admin.get(`/companies/${companyId}`)).body;
    expect(c.ai).toMatchObject({ status: 'pending', reason: 'Generating a new draft…' });
    expect(c.stages.personalization.status).toBe('in_progress');
  });

  it('cannot approve without a draft (409)', async () => {
    const r = await admin.patch(`/companies/${companyId}/ai`).send({ action: 'approve' });
    expect([r.status, r.body.error.message]).toEqual([409, 'There is no draft to approve. Add evidence or regenerate first.']);
  });

  it('save → approve → regenerate keeps the approved copy', async () => {
    expect((await admin.patch(`/companies/${companyId}/ai`).send({ action: 'save', fields: { nope: 'x' } })).status).toBe(400);
    expect((await admin.patch(`/companies/${companyId}/ai`).send({ action: 'save' })).status).toBe(400);
    const saved = (
      await admin
        .patch(`/companies/${companyId}/ai`)
        .send({ action: 'save', fields: { summary: 'Edited by Ali' } })
        .expect(200)
    ).body;
    expect(saved).toMatchObject({ status: 'draft', summary: 'Edited by Ali' });
    expect(saved.versions[0]).toMatchObject({
      by: 'admin@example.com',
      fields: { summary: 'Edited by Ali', hyperPersonalization: 'Live draft opener' },
    });

    const approved = (await admin.patch(`/companies/${companyId}/ai`).send({ action: 'approve' }).expect(200)).body;
    expect(approved.status).toBe('approved');
    expect(approved.approved.fields.summary).toBe('Edited by Ali');
    expect((await admin.get(`/companies/${companyId}`)).body.stages.personalization.status).toBe('approved');

    await admin.post(`/companies/${companyId}/ai/regenerate`).expect(202); // no model: pending again
    const after = (await admin.get(`/companies/${companyId}`)).body.ai;
    expect(after.status).toBe('pending');
    expect(after.approved.fields.summary).toBe('Edited by Ali'); // FR-30
    const history = (await admin.get(`/companies/${companyId}/history`)).body.map((h: { field: string }) => h.field);
    expect(history).toEqual(expect.arrayContaining(['ai.save', 'ai.approve']));
  });

  it('reject needs a reason; contact drafts work the same way', async () => {
    expect((await admin.patch(`/contacts/${samId}/ai`).send({ action: 'reject' })).status).toBe(400);
    const r = (await admin.patch(`/contacts/${samId}/ai`).send({ action: 'reject', reason: 'Too pushy' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'rejected', reason: 'Too pushy' });
    const ok = (
      await admin
        .patch(`/contacts/${samId}/ai`)
        .send({ action: 'save', fields: { subject: 'Better subject' } })
        .expect(200)
    ).body;
    expect(ok).toMatchObject({ status: 'draft', subject: 'Better subject' });
    expect((await admin.get(`/companies/${companyId}/history`)).body[0].field).toBe(`contact:${samId}:ai.save`);
  });
});

describe('exports', () => {
  const csvOf = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n');

  it('outreach.csv: frontend columns, BOM, CRLF, initial = not_checked, opt-outs left out, formula-safe', async () => {
    const r = await admin
      .get('/exports/outreach.csv?version=initial')
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString('utf8')));
        res.on('end', () => cb(null, d));
      });
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toBe('attachment; filename="outreach-initial.csv"');
    const text = r.body as string;
    expect(text.startsWith('﻿')).toBe(true);
    const lines = csvOf(text);
    expect(lines[0]).toBe(
      'Company ID,Company,Domain,Website,ADIPEC Profile URL,LinkedIn Company,Contact ID,First Name,Last Name,Title,Profile URL,Email,Email Verification Status,Verification Date,Contact Source,Hyper-Personalization,Subject Line,Email Draft,LinkedIn Draft,Evidence URLs,AI Status',
    );
    expect(lines).toHaveLength(3); // header + Sam + Bare Co (company-only row)
    expect(lines.find((l) => l.includes('Sam'))).toContain('sam@good.example,not_checked,');
    expect(text).not.toContain('optout.example');
    expect(lines.find((l) => l.startsWith(bareId))).toContain('Bare Co');
  });

  it('companies.csv escapes formulas and quotes; count matches; downloads are logged', async () => {
    const text = (
      await admin
        .get('/exports/companies.csv')
        .buffer(true)
        .parse((res, cb) => {
          let d = '';
          res.on('data', (c: Buffer) => (d += c.toString('utf8')));
          res.on('end', () => cb(null, d));
        })
    ).body as string;
    expect(text).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(text).toContain('"Drilling, ""the good kind"", in the Gulf"');
    expect((await admin.get('/exports/companies/count')).body).toEqual({ rows: 2 });
    expect((await admin.get('/exports/contacts/count')).body).toEqual({ rows: 2 }); // one row per non-opted-out email
    expect((await admin.get('/exports/outreach/count?country=united arab emirates')).body).toEqual({ rows: 1 });
    const log = (await admin.get('/exports/log')).body;
    expect(log.items[0]).toMatchObject({ kind: 'companies', version: 'initial', rows: 2, by: 'admin@example.com' });
    expect(await ExportLog.countDocuments()).toBe(2);
    expect((await admin.get('/exports/nope.csv')).status).toBe(400);
    expect((await admin.get('/exports/outreach.csv?version=draft')).status).toBe(400);
  });
});

describe('email verification', () => {
  it('free MX check: bad domain → invalid, good → unknown (never verified), dated and sourced', async () => {
    clearMxCache();
    await verificationStep(job({ companyId }));
    const sam = (await Contact.findById(samId).lean())!;
    const by = Object.fromEntries(sam.emails.map((e) => [e.address, e.verification]));
    expect(by['sam@good.example']).toMatchObject({ status: 'unknown', source: expect.stringContaining('mx-check') });
    expect(by['sam@nomail.example']).toMatchObject({ status: 'invalid', source: 'mx-check: Email domain does not exist' });
    expect(by['x@optout.example']?.status).toBe('not_checked'); // opted out: not touched
    expect(by['sam@good.example']?.checkedAt).toBeInstanceOf(Date);
    expect((await Company.findById(companyId).lean())?.stages?.verification).toMatchObject({
      status: 'partial',
      reason: 'MX check only: deliverability was not confirmed.',
    });
  });

  it('final export carries the real results and dates', async () => {
    const text = (
      await admin
        .get('/exports/contacts.csv?version=final')
        .buffer(true)
        .parse((res, cb) => {
          let d = '';
          res.on('data', (c: Buffer) => (d += c.toString('utf8')));
          res.on('end', () => cb(null, d));
        })
    ).body as string;
    // Email, type, provider (none here), captured, status, check date, source
    expect(text).toMatch(/sam@nomail\.example,business,,[^,]+,invalid,\d{4}-\d\d-\d\dT[^,]+,mx-check/);
  });

  it('MillionVerifier maps results, and stops cleanly when out of credits', async () => {
    env.MILLIONVERIFIER_API_KEY = 'mv-key';
    await Contact.updateOne({ _id: samId }, { $set: { 'emails.$[].verification': { status: 'not_checked' } } });
    const results: Record<string, object> = {
      'sam@good.example': { result: 'ok', subresult: 'ok', error: '' },
      'sam@nomail.example': { result: 'catch_all', error: '' },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input));
      expect(u.origin + u.pathname).toBe('https://api.millionverifier.com/api/v3/');
      return new Response(JSON.stringify(results[u.searchParams.get('email')!]));
    });
    await verificationStep(job({ companyId }));
    const by = Object.fromEntries((await Contact.findById(samId).lean())!.emails.map((e) => [e.address, e.verification?.status]));
    expect(by).toMatchObject({ 'sam@good.example': 'verified', 'sam@nomail.example': 'risky' });
    expect((await Company.findById(companyId).lean())?.stages?.verification?.status).toBe('completed');

    await Contact.updateOne({ _id: samId }, { $set: { 'emails.$[].verification': { status: 'not_checked' } } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'Insufficient credits' })));
    await verificationStep(job({ companyId }));
    expect((await Company.findById(companyId).lean())?.stages?.verification).toMatchObject({
      status: 'pending_access',
      reason: expect.stringContaining('MillionVerifier is out of credits'),
    });
  });

  it('POST /verification/run starts a verification-only run', async () => {
    await Contact.updateOne({ _id: samId }, { $set: { 'emails.0.verification': { status: 'not_checked' } } });
    await Company.updateOne({ _id: companyId }, { emailStatuses: ['not_checked'] });
    const r = (await admin.post('/verification/run').send({ edition: 2026 }).expect(202)).body;
    expect(r.queued).toBe(true);
    const run = (await admin.get(`/runs/${r.runId}`)).body;
    expect(run).toMatchObject({ steps: ['verification'], status: 'running' });
    expect(run.perStep.verification.queued).toBe(1);
    expect((await admin.post('/verification/run').send({ edition: 2026 })).status).toBe(409);
    await Run.updateOne({ _id: r.runId }, { status: 'completed' });
  });
});

describe('gap report', () => {
  it('JSON and CSV list every blocked step with its reason', async () => {
    const r = (await admin.get('/reports/gap').expect(200)).body;
    expect(r).toMatchObject({ edition: 2026, advertised: 2260, discovered: 2, researched: 1, contactsFound: 1 });
    expect(r.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyName: 'Bare Co', step: 'website', status: 'failed', reason: 'Domain gone' }),
        expect.objectContaining({ companyName: 'Example Drilling', step: 'account', status: 'pending_access' }),
      ]),
    );
    const csv = await admin.get('/reports/gap.csv?edition=2026');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="gap-report-2026.csv"');
    expect(csv.text.split('\r\n')[0]).toBe('﻿Company ID,Company,Step,Status,Reason');
    expect((await admin.get('/reports/gap?edition=1999')).status).toBe(404);
  });
});
