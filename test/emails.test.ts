/** Email lookup step with ContactOut replaced by a fake fetch. */
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Company, Contact, Suppression, Usage } from '../src/db/models.js';
import { env } from '../src/env.js';
import { closeQueues } from '../src/pipeline/queue.js';
import { emailsStep } from '../src/pipeline/steps/emails.js';

afterAll(() => closeQueues());

const job = (companyId: unknown) => ({ data: { companyId: String(companyId) } }) as Job;
const answers = new Map<string, [number, object | string]>(); // profile url → [status, body]
let calls = 0;

beforeEach(async () => {
  await Usage.deleteMany({});
  calls = 0;
  env.CONTACTOUT_API_KEY = 'test-key';
  env.CONTACTOUT_MAX_LOOKUPS = 50;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://api.contactout.com/v1/people/linkedin');
    expect(url.searchParams.get('email_type')).toBe('work');
    expect((init?.headers as Record<string, string> | undefined)?.token).toBe('test-key');
    const [status, body] = answers.get(url.searchParams.get('profile')!) ?? [404, { status_code: 404, message: 'Not Found' }];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.CONTACTOUT_API_KEY = undefined;
});

async function companyWith(people: { first: string; profile?: string; email?: string }[]) {
  const c = await Company.create({ name: `Co ${Math.random()}`, normalizedName: `co ${Math.random()}` });
  for (const p of people)
    await Contact.create({
      company: c._id,
      firstName: p.first,
      lastName: 'Example',
      source: 'manual',
      profileUrl: p.profile,
      emails: p.email ? [{ address: p.email, type: 'business' }] : [],
    });
  return c;
}
const stepOf = async (id: unknown) => (await Company.findById(id).lean())?.stages?.emails;

describe('email lookup step', () => {
  it('waits when there are no contacts, and needs nothing when everyone has an email', async () => {
    const none = await companyWith([]);
    await emailsStep(job(none._id));
    expect(await stepOf(none._id)).toMatchObject({ status: 'not_started', reason: 'No contacts yet' });

    const all = await companyWith([{ first: 'A', email: 'a@x.example' }]);
    await emailsStep(job(all._id));
    expect((await stepOf(all._id))?.status).toBe('completed');
    expect(calls).toBe(0);
  });

  it('without a ContactOut key, asks for emails by hand and spends nothing', async () => {
    env.CONTACTOUT_API_KEY = undefined;
    const c = await companyWith([{ first: 'A', profile: 'https://www.linkedin.com/in/a' }]);
    await emailsStep(job(c._id));
    expect(await stepOf(c._id)).toMatchObject({ status: 'pending_access', reason: expect.stringContaining('ContactOut isn’t connected') });
    expect(calls).toBe(0);
  });

  it('stores work emails with provider and date; reports who had none or no profile link', async () => {
    answers.set('https://www.linkedin.com/in/found', [
      200,
      { status_code: 200, profile: { work_email: ['Found@Corp.example'], work_email_status: { 'Found@Corp.example': 'Verified' } } },
    ]);
    const c = await companyWith([
      { first: 'Found', profile: 'https://www.linkedin.com/in/found' },
      { first: 'Missing', profile: 'https://www.linkedin.com/in/missing' },
      { first: 'NoLink' },
    ]);
    await emailsStep(job(c._id));
    const found = (await Contact.findOne({ company: c._id, firstName: 'Found' }).lean())!;
    expect(found.emails[0]).toMatchObject({
      address: 'found@corp.example',
      type: 'business',
      provider: 'contactout',
      providerStatus: 'Verified',
      verification: { status: 'not_checked' }, // the provider's word is not our verification
    });
    expect(await stepOf(c._id)).toMatchObject({
      status: 'partial',
      reason: 'Found emails for 1 of 3 contact(s). 1 had none in ContactOut. 1 have no LinkedIn profile link',
    });
    expect((await Company.findById(c._id).lean())?.emailStatuses).toEqual(['not_checked']);
  });

  it('never stores an opted-out email', async () => {
    await Suppression.create({ value: 'optedout.example' });
    answers.set('https://www.linkedin.com/in/opt', [200, { profile: { work_email: ['x@optedout.example'] } }]);
    const c = await companyWith([{ first: 'Opt', profile: 'https://www.linkedin.com/in/opt' }]);
    await emailsStep(job(c._id));
    expect((await Contact.findOne({ company: c._id }).lean())?.emails).toEqual([]);
  });

  it('stops at the monthly cap', async () => {
    env.CONTACTOUT_MAX_LOOKUPS = 1;
    const c = await companyWith([
      { first: 'One', profile: 'https://www.linkedin.com/in/one' },
      { first: 'Two', profile: 'https://www.linkedin.com/in/two' },
    ]);
    await emailsStep(job(c._id));
    expect(calls).toBe(1);
    expect(await stepOf(c._id)).toMatchObject({
      status: 'pending_access',
      reason: expect.stringContaining('Monthly ContactOut limit reached (1 lookups)'),
    });
  });

  it('stops cleanly when ContactOut is out of credits', async () => {
    answers.set('https://www.linkedin.com/in/c', [403, "You're out of credits, please email your sales manager"]);
    const c = await companyWith([{ first: 'C', profile: 'https://www.linkedin.com/in/c' }]);
    await emailsStep(job(c._id));
    expect(await stepOf(c._id)).toMatchObject({
      status: 'pending_access',
      reason: expect.stringContaining('ContactOut is out of credits'),
    });
  });

  it('lets BullMQ retry when rate-limited', async () => {
    answers.set('https://www.linkedin.com/in/r', [429, { message: 'Rate limit reached' }]);
    const c = await companyWith([{ first: 'R', profile: 'https://www.linkedin.com/in/r' }]);
    await expect(emailsStep(job(c._id))).rejects.toThrow('HTTP 429');
  });
});
