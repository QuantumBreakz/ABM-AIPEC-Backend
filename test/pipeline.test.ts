/**
 * Directory + profile steps end to end, with adipec.com replaced by the fixture files.
 * Handlers are called directly (no worker), and enqueue() is observed through the queue.
 */
import { readFileSync } from 'node:fs';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Company, Event, Run } from '../src/db/models.js';
import { FetchError } from '../src/lib/fetcher.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/adipec/${name}`, import.meta.url), 'utf8');
const failing = new Set<string>(); // detail ids that should fail

vi.mock('../src/lib/fetcher.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/fetcher.js')>();
  return {
    ...real,
    fetchPage: vi.fn(async (url: string) => ({ url, status: 200, contentType: 'text/html', body: fixture('list-page.html') })),
    fetchJson: vi.fn(async (url: string) => {
      if (url.endsWith('getallexhibitorslist')) return JSON.parse(fixture('list.json'));
      if (url.endsWith('getalllevelproductcategorieslist')) return JSON.parse(fixture('categories.json'));
      const id = new URL(url).searchParams.get('exhibitorid')!;
      if (failing.has(id)) throw new real.FetchError('blocked', `Access denied (403): ${url}`, 403);
      return JSON.parse(fixture(`detail-${id}.json`));
    }),
  };
});

const { directoryStep } = await import('../src/pipeline/steps/directory.js');
const { profileStep } = await import('../src/pipeline/steps/profile.js');
const { handlers, closeQueues, drainAll, requeue } = await import('../src/pipeline/queue.js');
const { onFinalFailure, requeueUnfinished, summarize } = await import('../src/pipeline/runs.js');

handlers.directory = directoryStep;
handlers.profile = profileStep;
const job = (data: object) => ({ data }) as Job;

async function runAll(runId: string) {
  await directoryStep(job({ runId }));
  const queued = await Company.find({ 'stages.profile.status': 'in_progress' }, { _id: 1 }).lean();
  for (const c of queued) await profileStep(job({ companyId: String(c._id), runId }));
}

let runId = '';
beforeAll(async () => {
  await drainAll();
  await Event.create({ edition: 2026, name: 'ADIPEC 2026', directoryUrl: 'https://www.adipec.com/exhibition/exhibitor-list/' });
  runId = String((await Run.create({ edition: 2026, steps: ['directory', 'profile'], startedBy: 'test' }))._id);
  await runAll(runId);
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('directory step', () => {
  it('saves advertised count and categories on the event', async () => {
    const e = (await Event.findOne({ edition: 2026 }).lean())!;
    expect(e.advertisedCount).toBe(2260);
    expect((e.categoryPaths as any)['3']).toBe('O&G > Upstream > Drilling Contractor');
  });

  it('merges listings of the same company and counts the merge as a duplicate', async () => {
    const run = (await Run.findById(runId).lean())!;
    expect(run).toMatchObject({ discovered: 4, duplicates: 1, directoryDone: true });
    expect(await Company.countDocuments()).toBe(3);
    const drilling = (await Company.findOne({ normalizedName: 'example drilling' }).lean())!;
    expect(drilling.editions.map((e) => e.sourceId).sort()).toEqual(['101', '103']);
    expect(drilling.originalNames.sort()).toEqual(['EXAMPLE DRILLING LLC', 'Example Drilling L.L.C.']);
  });
});

describe('profile step', () => {
  it('completes a full profile and fills website, domain, socials, categories', async () => {
    const c = (await Company.findOne({ normalizedName: 'example drilling' }).lean())!;
    expect(c.stages?.profile?.status).toBe('completed');
    expect(c.website?.url).toBe('https://www.exampledrilling.example/');
    expect(c.domain).toBe('exampledrilling.example');
    expect(c.socials?.linkedin).toBe('https://www.linkedin.com/company/example-drilling');
    const main = c.editions.find((e) => e.sourceId === '101')!;
    expect(main).toMatchObject({ description: 'Example Drilling provides invented drilling services.', category: 'O&G' });
    expect((main.extra as any).city).toBe('Abu Dhabi');
  });

  it('marks a thin profile partial and says what is missing', async () => {
    const c = (await Company.findOne({ normalizedName: 'sample energy group' }).lean())!;
    expect(c.stages?.profile).toMatchObject({ status: 'partial', reason: 'Profile has no website, description, category' });
  });

  it('notes a domain already used by another company instead of failing', async () => {
    const id = String((await Company.findOne({ normalizedName: 'demo subsea' }).lean())!._id);
    await Company.updateOne({ _id: id }, { $unset: { domain: 1 } }); // pretend another company got there first
    await Company.create({ name: 'Other Owner', normalizedName: 'other owner', domain: 'demosubsea.example' });
    await profileStep(job({ companyId: id, runId }));
    const c = (await Company.findOne({ normalizedName: 'demo subsea' }).lean())!;
    expect(c.domain).toBeUndefined();
    expect(c.stages?.profile).toMatchObject({ status: 'partial' });
    expect(c.stages?.profile?.reason).toContain('already on "Other Owner"');
  });

  it('marks a blocked profile restricted, never failed silently', async () => {
    failing.add('104');
    const id = String((await Company.findOne({ normalizedName: 'demo subsea' }).lean())!._id);
    await profileStep(job({ companyId: id, runId }));
    failing.delete('104');
    expect((await Company.findById(id).lean())?.stages?.profile).toMatchObject({
      status: 'restricted',
      reason: expect.stringContaining('403'),
    });
  });

  it('never overwrites a field a person edited', async () => {
    const id = String((await Company.findOne({ normalizedName: 'example drilling' }).lean())!._id);
    await Company.updateOne({ _id: id }, { 'website.url': 'https://human-choice.example.com/', lockedFields: ['website.url'] });
    await profileStep(job({ companyId: id, runId }));
    expect((await Company.findById(id).lean())?.website?.url).toBe('https://human-choice.example.com/');
  });
});

describe('re-running and failures', () => {
  it('a second run creates no duplicates (AT-10)', async () => {
    const before = await Company.find().lean();
    await runAll(runId);
    const after = await Company.find().lean();
    expect(after.length).toBe(before.length);
    for (const c of after) expect(new Set(c.editions.map((e) => `${e.edition}-${e.sourceId}`)).size).toBe(c.editions.length);
  });

  it('a job that fails for good marks the step failed and records it on the run', async () => {
    const c = (await Company.findOne({ normalizedName: 'sample energy group' }).lean())!;
    await onFinalFailure('profile', job({ companyId: String(c._id), runId }) as any, new FetchError('timeout', 'Timed out'));
    expect((await Company.findById(c._id).lean())?.stages?.profile).toMatchObject({ status: 'failed', reason: 'Timed out' });
    const run = (await Run.findById(runId).lean())!;
    expect(run.errors.at(-1)).toMatchObject({ step: 'profile', companyName: 'Sample Energy Group', message: 'Timed out' });
  });

  it('summarizes counts from Mongo', async () => {
    const s = await summarize((await Run.findById(runId).lean())!);
    expect(s.counts).toMatchObject({ discovered: 4, duplicate: 1, attempted: 3 });
    expect(s.perStep.directory).toEqual({ queued: 0, done: 1, failed: 0 });
    expect(s.perStep.profile.failed).toBe(1);
  });
});

describe('queue survives a Redis wipe', () => {
  it('rebuilds queued jobs from Mongo on boot', async () => {
    const c = (await Company.findOne({ normalizedName: 'example drilling' }).lean())!;
    await Company.updateOne({ _id: c._id }, { 'stages.profile.status': 'in_progress' });
    await Run.updateOne({ _id: runId }, { status: 'running' });
    await drainAll(); // simulate Render wiping Redis
    await requeueUnfinished();
    const { Queue } = await import('bullmq');
    const { redis, PREFIX } = await import('../src/pipeline/queue.js');
    const q = new Queue('profile', { connection: redis, prefix: PREFIX });
    expect(await q.getJob(`profile-${c._id}`)).toBeTruthy();
    await requeue('profile', { companyId: String(c._id), runId }); // same id → still one job
    expect(await q.getJobCountByTypes('waiting', 'prioritized')).toBe(1);
  });
});
