/**
 * Behaviour the frontend (ABM-AIPEC-Frontend, src/mocks/handlers) relies on.
 * If one of these fails, the real backend and Faseeh's mock backend have drifted apart.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { refreshContactStats } from '../src/db/helpers.js';
import { Company, Contact, Event, Run, User } from '../src/db/models.js';
import { closeQueues, drainAll } from '../src/pipeline/queue.js';

let admin: ReturnType<typeof request.agent>;
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

beforeAll(async () => {
  await User.create({ email: 'admin@example.com', role: 'admin', passwordHash: await bcrypt.hash('password-123', 4) });
  admin = request.agent(app);
  await admin.post('/auth/login').send({ email: 'admin@example.com', password: 'password-123' }).expect(200);
  await Event.create({ edition: 2026, name: 'ADIPEC 2026', directoryUrl: 'https://www.adipec.com/exhibition/exhibitor-list/' });

  const [kept, dup, ai] = await Company.create([
    {
      name: 'Kappa Energy',
      normalizedName: 'kappa energy',
      originalNames: ['KAPPA ENERGY L.L.C.', 'Kappa Petroleum Services'],
      editions: [{ edition: 2026, sourceId: '1', country: 'United Arab Emirates' }],
      stages: {
        website: { status: 'failed', reason: 'The website answered HTTP 500', updatedAt: day(3) },
        account: { status: 'pending_access', reason: 'Waiting for Sales Navigator review', updatedAt: day(4) },
        people: { status: 'partial', reason: 'Only the CEO was found', updatedAt: day(4) },
      },
    },
    {
      name: 'Kappa Energy Copy',
      normalizedName: 'kappa energy copy',
      editions: [{ edition: 2026, sourceId: '2', country: 'Arab Emirates Free Zone' }],
      stages: { account: { status: 'pending_access', updatedAt: day(5) } },
    },
    {
      name: 'Lambda Draft',
      normalizedName: 'lambda draft',
      editions: [{ edition: 2026, sourceId: '3' }],
      ai: { status: 'rejected', reason: 'Too generic' },
    },
  ]);
  await Company.updateOne({ _id: dup._id }, { duplicateOf: kept._id });
  await Contact.create([
    {
      company: kept._id,
      firstName: 'Ana',
      lastName: 'Sample',
      source: 'manual',
      emails: [
        { address: 'ana@kappa.example', verification: { status: 'invalid', checkedAt: day(6) } },
        { address: 'a.s@kappa.example', verification: { status: 'verified', checkedAt: day(6) } },
        { address: 'ana.s@kappa.example', verification: { status: 'risky', checkedAt: day(7) } },
      ],
    },
    {
      company: ai._id,
      firstName: 'Bo',
      lastName: 'Demo',
      source: 'manual',
      ai: { status: 'insufficient_evidence', reason: 'No sourced signal' },
    },
  ]);
  for (const c of [kept, ai]) await refreshContactStats(c._id); // the API does this on every contact change
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('review queue matches the frontend rules', () => {
  it('counts every tab the same way', async () => {
    expect((await admin.get('/review/counts').expect(200)).body).toEqual({
      website: 1, // failed counts too
      duplicate: 1,
      salesnav: 1, // the flagged duplicate is left out
      contacts: 0, // Kappa has a contact, so the partial people step isn't a contacts item
      emails: 2, // one item per invalid/risky/unknown email, not per company
      ai: 2, // company draft + contact draft
    });
  });

  it('lists one item per problem email, with the contact, newest first', async () => {
    const { items } = (await admin.get('/review?type=emails').expect(200)).body;
    expect(items).toEqual([
      expect.objectContaining({ contactName: 'Ana Sample', reason: 'ana.s@kappa.example is risky.', since: day(7).toISOString() }),
      expect.objectContaining({ contactName: 'Ana Sample', reason: 'ana@kappa.example is invalid.', since: day(6).toISOString() }),
    ]);
    expect(items[0].contactId).toEqual(expect.any(String));
  });

  it('includes contact drafts in the AI tab and explains duplicates', async () => {
    const ai = (await admin.get('/review?type=ai')).body.items;
    const rows = ai.map((i: { contactName?: string; reason: string }) => `${i.contactName ?? 'company'}: ${i.reason}`).sort();
    expect(rows).toEqual(['Bo Demo: No sourced signal', 'company: Too generic']);
    expect((await admin.get('/review?type=duplicate')).body.items[0].reason).toBe('Possible duplicate of Kappa Energy.');
  });

  it('shows contacts items for a people step needing review with no contacts', async () => {
    await Company.create({
      name: 'Mu Pumps',
      normalizedName: 'mu pumps',
      stages: { people: { status: 'needs_review', reason: 'No CXOs listed' } },
    });
    expect((await admin.get('/review?type=contacts')).body.items[0]).toMatchObject({ companyName: 'Mu Pumps', reason: 'No CXOs listed' });
  });
});

describe('companies list', () => {
  it('searches original names and matches country exactly (any case)', async () => {
    expect((await admin.get('/companies?q=petroleum services')).body.items.map((c: { name: string }) => c.name)).toEqual(['Kappa Energy']);
    expect((await admin.get('/companies?country=united arab emirates')).body.total).toBe(1);
    expect((await admin.get('/companies?country=Arab Emirates')).body.total).toBe(0); // not a contains-match
  });

  it('scores completeness from step statuses', async () => {
    const { items } = (await admin.get('/companies?q=kappa energy copy')).body;
    expect(items[0].completeness).toBe(0);
  });
});

describe('editing clears fields with "" or null', () => {
  it('clears text, links and confidence; coverage goes back to unknown', async () => {
    const id = String((await Company.findOne({ name: 'Lambda Draft' }).lean())!._id);
    await admin
      .patch(`/companies/${id}`)
      .send({ website: { summary: 'x' }, socials: { x: 'https://x.com/l' }, leadershipCoverage: 'reviewed' })
      .expect(200);
    const r = await admin
      .patch(`/companies/${id}`)
      .send({ website: { summary: '' }, socials: { x: null }, leadershipCoverage: '' })
      .expect(200);
    expect(r.body.website.summary).toBeUndefined();
    expect(r.body.socials.x).toBeUndefined();
    expect(r.body.leadershipCoverage).toBe('unknown');
  });

  it('accepts any http(s) link for the Sales Navigator account', async () => {
    const id = String((await Company.findOne({ name: 'Lambda Draft' }).lean())!._id);
    const r = await admin
      .patch(`/companies/${id}`)
      .send({ salesNav: { accountUrl: 'https://www.linkedin.com/sales/company/123' } })
      .expect(200);
    expect(r.body.salesNav.accountUrl).toBe('https://www.linkedin.com/sales/company/123');
  });

  it('logs a step override as status → status', async () => {
    const id = String((await Company.findOne({ name: 'Lambda Draft' }).lean())!._id);
    await admin.post(`/companies/${id}/steps/account`).send({ status: 'completed', reason: 'Done in Sales Nav' }).expect(200);
    const [latest] = (await admin.get(`/companies/${id}/history`)).body;
    expect(latest).toMatchObject({ field: 'stages.account', before: 'not_started', after: 'completed', by: 'admin@example.com' });
  });
});

describe('runs', () => {
  it('accepts every step the start dialog offers, and runs all 9 by default', async () => {
    const all = (await admin.post('/runs').send({ edition: 2026 }).expect(202)).body;
    expect(all.steps).toEqual([
      'directory',
      'profile',
      'website',
      'social',
      'account',
      'people',
      'emails',
      'verification',
      'personalization',
    ]);
    expect(Object.keys(all.perStep)).toEqual(all.steps);
    await Run.updateOne({ _id: all.id }, { status: 'completed' });

    const some = (
      await admin
        .post('/runs')
        .send({ edition: 2026, steps: ['social', 'account', 'verification'] })
        .expect(202)
    ).body;
    expect(some.steps).toEqual(['social', 'account', 'verification']);
    await Run.updateOne({ _id: some.id }, { status: 'completed' });
  });

  it('lists run errors newest first', async () => {
    const run = await Run.create({
      edition: 2026,
      steps: ['profile'],
      status: 'completed',
      errors: [
        { step: 'profile', message: 'first', at: day(1) },
        { step: 'profile', message: 'second', at: day(2) },
      ],
    });
    expect((await admin.get(`/runs/${run._id}`)).body.errors.map((e: { message: string }) => e.message)).toEqual(['second', 'first']);
  });

  it('resuming a run with nothing left to do finishes it right away', async () => {
    const paused = await Run.create({ edition: 2026, steps: ['social'], status: 'paused' });
    const r = await admin.post(`/runs/${paused._id}/resume`).expect(200);
    expect(r.body.status).toBe('completed');
  });

  it('says why a new run is refused while one is paused', async () => {
    const paused = await Run.create({ edition: 2026, steps: ['profile'], status: 'paused' });
    const r = await admin.post('/runs').send({ edition: 2026 });
    expect([r.status, r.body.error.message]).toEqual([409, 'A paused run exists. Resume it (or let it finish) before starting another.']);
    await Run.updateOne({ _id: paused._id }, { status: 'completed' });
  });
});
