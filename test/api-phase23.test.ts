import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Company, Contact, User } from '../src/db/models.js';
import { closeQueues, drainAll, handlers } from '../src/pipeline/queue.js';

const PASSWORD = 'correct-horse-battery';
let admin: ReturnType<typeof request.agent>;
let reviewer: ReturnType<typeof request.agent>;
let companyId = '';

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await User.create([
    { email: 'admin@example.com', role: 'admin', passwordHash },
    { email: 'rev@example.com', role: 'reviewer', passwordHash },
  ]);
  admin = request.agent(app);
  reviewer = request.agent(app);
  await admin.post('/auth/login').send({ email: 'admin@example.com', password: PASSWORD }).expect(200);
  await reviewer.post('/auth/login').send({ email: 'rev@example.com', password: PASSWORD }).expect(200);
  companyId = String(
    (
      await Company.create({
        name: 'Delta Drilling',
        normalizedName: 'delta drilling',
        editions: [{ edition: 2026, sourceId: '1' }],
        stages: { website: { status: 'needs_review', reason: 'No website on the ADIPEC profile' } },
      })
    )._id,
  );
  await Company.create({ name: 'Other Owner', normalizedName: 'other owner', domain: 'taken.example' });
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('editing a company', () => {
  it('accepts nested or dotted fields, records history and locks what a person changed', async () => {
    const r = await reviewer
      .patch(`/companies/${companyId}`)
      .send({
        website: { summary: 'Edited by a person' },
        'socials.linkedin': 'https://www.linkedin.com/company/delta',
        leadershipCoverage: 'reviewed',
      })
      .expect(200);
    expect(r.body).toMatchObject({
      website: { summary: 'Edited by a person' },
      socials: { linkedin: 'https://www.linkedin.com/company/delta' },
      leadershipCoverage: 'reviewed',
    });
    expect(r.body.lockedFields.sort()).toEqual(['leadershipCoverage', 'socials.linkedin', 'website.summary']);
    const history = (await reviewer.get(`/companies/${companyId}/history`).expect(200)).body;
    expect(history.map((h: { field: string }) => h.field).sort()).toEqual(['leadershipCoverage', 'socials.linkedin', 'website.summary']);
    expect(history[0].by).toBe('rev@example.com');
  });

  it('rejects unknown fields and bad links', async () => {
    expect((await reviewer.patch(`/companies/${companyId}`).send({ name: 'Hacked' })).status).toBe(400);
    expect((await reviewer.patch(`/companies/${companyId}`).send({ salesNav: { accountUrl: 'https://evil.example/x' } })).status).toBe(400);
    expect((await reviewer.patch(`/companies/${companyId}`).send({})).status).toBe(400);
  });

  it('a new website sets the domain, refuses one owned by another company, and queues research', async () => {
    expect((await reviewer.patch(`/companies/${companyId}`).send({ website: { url: 'https://www.taken.example/' } })).status).toBe(409);
    // Pretend the website step exists (pipeline/index.ts isn't loaded in API tests) so the follow-up gets queued.
    const saved = handlers.website;
    handlers.website = async () => {};
    const r = await reviewer
      .patch(`/companies/${companyId}`)
      .send({ website: { url: 'https://www.deltadrilling.example/' } })
      .expect(200);
    handlers.website = saved;
    expect(r.body.domain).toBe('deltadrilling.example');
    expect(r.body.stages.website).toMatchObject({ status: 'in_progress', reason: 'queued' }); // fresh research queued
  });

  it('lets a reviewer set a step by hand, with a reason, without locking it', async () => {
    expect((await reviewer.post(`/companies/${companyId}/steps/account`).send({ status: 'completed' })).status).toBe(400);
    expect((await reviewer.post(`/companies/${companyId}/steps/account`).send({ status: 'in_progress', reason: 'no' })).status).toBe(400);
    const r = await reviewer
      .post(`/companies/${companyId}/steps/account`)
      .send({ status: 'completed', reason: 'Found in Sales Nav' })
      .expect(200);
    expect(r.body.stages.account).toMatchObject({ status: 'completed', reason: 'Found in Sales Nav' });
    expect(r.body.lockedFields).not.toContain('stages.account');
  });
});

describe('contacts', () => {
  it('adds a contact, normalises the LinkedIn link, and refuses the same person twice', async () => {
    const r = await reviewer
      .post(`/companies/${companyId}/contacts`)
      .send({
        firstName: 'Sam',
        lastName: 'Example',
        title: 'CTO',
        profileUrl: 'https://linkedin.com/in/Sam-Example/?trk=abc',
        source: 'manual',
        emails: [{ address: 'Sam@Delta.example' }],
      })
      .expect(201);
    expect(r.body).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/sam-example',
      emails: [{ address: 'sam@delta.example', verification: { status: 'not_checked' } }],
    });
    expect(
      (await reviewer.post(`/companies/${companyId}/contacts`).send({ firstName: 'sam', lastName: 'EXAMPLE', source: 'manual' })).status,
    ).toBe(409);
    expect((await reviewer.post(`/companies/${companyId}/contacts`).send({ firstName: 'X', source: 'manual' })).status).toBe(400);
  });

  it('refuses opted-out emails', async () => {
    await admin.post('/suppressions').send({ value: 'optout.example', reason: 'Asked to be removed' }).expect(201);
    const r = await reviewer
      .post(`/companies/${companyId}/contacts`)
      .send({ firstName: 'Opt', lastName: 'Out', source: 'manual', emails: [{ address: 'a@optout.example' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('opted out');
  });

  it('imports a pasted CSV: good rows in, bad rows reported, re-import adds nothing', async () => {
    const csv = [
      'First Name,Last Name,Title,Profile URL,Email',
      'Kim,Sample,CEO,https://www.linkedin.com/in/kim,kim@delta.example',
      ',Missing,CFO,,',
      'Lee,Demo,COO,not-a-url,',
      'Sam,Example,CTO,,sam.second@delta.example',
      'Opt,Person,VP,,b@optout.example',
    ].join('\n');
    const r = await reviewer.post(`/companies/${companyId}/contacts/import`).send({ csv }).expect(200);
    expect(r.body.created).toBe(1);
    expect(r.body.updated).toBe(1); // Sam already existed: new email added
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 6]);
    const again = await reviewer.post(`/companies/${companyId}/contacts/import`).send({ csv }).expect(200);
    expect([again.body.created, again.body.updated]).toEqual([0, 0]);
    const sam = (await Contact.findOne({ firstName: 'Sam' }).lean())!;
    expect(sam.emails.map((e) => e.address).sort()).toEqual(['sam.second@delta.example', 'sam@delta.example']);
    expect((await Company.findById(companyId).lean())?.contactsCount).toBe(2);
  });

  it('refuses a CSV without name columns', async () => {
    expect((await reviewer.post(`/companies/${companyId}/contacts/import`).send({ csv: 'email\na@b.example' })).status).toBe(400);
  });

  it('editing emails keeps check results for addresses that stay', async () => {
    const sam = (await Contact.findOne({ firstName: 'Sam' }).lean())!;
    await Contact.updateOne(
      { _id: sam._id, 'emails.address': 'sam@delta.example' },
      { $set: { 'emails.$.verification.status': 'verified' } },
    );
    const r = await reviewer
      .patch(`/contacts/${sam._id}`)
      .send({ emails: [{ address: 'sam@delta.example' }, { address: 'new@delta.example' }] })
      .expect(200);
    expect(r.body.emails.map((e: { address: string; verification: { status: string } }) => [e.address, e.verification.status])).toEqual([
      ['sam@delta.example', 'verified'],
      ['new@delta.example', 'not_checked'],
    ]);
    expect((await reviewer.get(`/companies/${companyId}/history`)).body.some((h: { field: string }) => h.field === 'contact.emails')).toBe(
      true,
    );
  });

  it('only admins delete contacts', async () => {
    const kim = (await Contact.findOne({ firstName: 'Kim' }).lean())!;
    expect((await reviewer.delete(`/contacts/${kim._id}`)).status).toBe(403);
    await admin.delete(`/contacts/${kim._id}`).expect(204);
    expect((await Company.findById(companyId).lean())?.contactsCount).toBe(1);
  });
});

describe('review queue', () => {
  it('counts and lists items by type, oldest first', async () => {
    await Company.create([
      {
        name: 'Needs Sales Nav',
        normalizedName: 'needs sales nav',
        stages: { account: { status: 'pending_access', reason: 'Waiting for Sales Navigator review' } },
      },
      { name: 'Bad AI', normalizedName: 'bad ai', ai: { status: 'insufficient_evidence', reason: 'No sourced signal' } },
    ]);
    const counts = (await reviewer.get('/review/counts').expect(200)).body;
    expect(counts).toMatchObject({ salesnav: 1, ai: 1, duplicate: 0 });
    const list = (await reviewer.get('/review?type=salesnav').expect(200)).body;
    expect(list.items[0]).toMatchObject({ type: 'salesnav', companyName: 'Needs Sales Nav', reason: 'Waiting for Sales Navigator review' });
    expect((await reviewer.get('/review?type=nope')).status).toBe(400);
  });
});

describe('settings, suppressions, delete', () => {
  it('reports providers as off when no keys are set', async () => {
    expect((await reviewer.get('/settings/providers').expect(200)).body).toEqual({ contactout: false, millionverifier: false, llm: false });
  });

  it('suppressions are admin-only and validated', async () => {
    expect((await reviewer.get('/suppressions')).status).toBe(403);
    expect((await admin.post('/suppressions').send({ value: 'not valid' })).status).toBe(400);
    expect((await admin.post('/suppressions').send({ value: 'optout.example' })).status).toBe(409);
    const list = (await admin.get('/suppressions').expect(200)).body;
    await admin.delete(`/suppressions/${list[0].id}`).expect(204);
  });

  it('only admins delete companies, and their contacts go too', async () => {
    expect((await reviewer.delete(`/companies/${companyId}`)).status).toBe(403);
    await admin.delete(`/companies/${companyId}`).expect(204);
    expect(await Contact.countDocuments({ company: companyId })).toBe(0);
    expect((await admin.get(`/companies/${companyId}`)).status).toBe(404);
  });
});
