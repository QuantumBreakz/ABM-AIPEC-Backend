/** AI drafting step, with the model replaced by queued fake answers. */
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Company, Contact } from '../src/db/models.js';
import { env } from '../src/env.js';

const answers: unknown[] = [];
const calls: string[] = [];
vi.mock('../src/providers/llm.js', async (orig) => {
  const real = await orig<typeof import('../src/providers/llm.js')>();
  return {
    ...real,
    generateJson: vi.fn(async (_system: string, prompt: string) => {
      calls.push(prompt);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('no fake answer queued');
      return next;
    }),
  };
});

const { personalizationStep, checkDraft, factPack } = await import('../src/pipeline/steps/personalization.js');
const { LlmStop, AI_REASON } = await import('../src/providers/llm.js');
const { closeQueues } = await import('../src/pipeline/queue.js');

afterAll(() => closeQueues());
beforeEach(() => {
  env.LLM_API_KEY = 'test-key';
  answers.length = 0;
  calls.length = 0;
});
afterEach(() => {
  env.LLM_API_KEY = undefined;
});

const job = (data: object) => ({ data }) as Job;
const facts = [
  {
    text: 'Example Drilling runs twelve land rigs for national oil companies.',
    sourceUrl: 'https://exampledrilling.example/about',
    kind: 'fact',
  },
  { text: 'Example Drilling may expand to Oman.', sourceUrl: 'https://exampledrilling.example/news', kind: 'inference' },
  { text: 'Example Drilling launched a rig-monitoring service in 2025.', sourceUrl: 'https://exampledrilling.example/news', kind: 'fact' },
];
const goodCompany = {
  summary: 'Example Drilling runs land rigs for national oil companies. It recently launched a monitoring service.',
  signalFactId: 'F2',
  signal: 'They launched a rig-monitoring service in 2025.',
  hypothesis: 'Rig data might be collected by hand across sites, which custom software could simplify.',
  hyperPersonalization: 'Saw the new rig-monitoring service launched in 2025.',
  citedFactIds: ['F1', 'F2'],
};
const goodContact = {
  subject: 'Rig monitoring at Example Drilling',
  draft: 'Hello Sam, I read about your rig-monitoring service. How do teams share rig data today?\n\nBest regards,',
  linkedinDraft: 'Hi Sam, quick question about rig monitoring.',
  citedFactIds: ['F2'],
};

async function setup(extra: object = {}) {
  const c = await Company.create({
    name: `Example ${Math.random()}`,
    normalizedName: `example ${Math.random()}`,
    website: { facts },
    ...extra,
  });
  const sam = await Contact.create({ company: c._id, firstName: 'Sam', lastName: 'Example', title: 'CTO', source: 'manual' });
  const kim = await Contact.create({
    company: c._id,
    firstName: 'Kim',
    lastName: 'Sample',
    source: 'manual',
    profileUrl: 'https://www.linkedin.com/in/kim',
  });
  return { c, sam, kim };
}

describe('pure checks', () => {
  it('only offers sourced facts (no inferences) to the model, numbered', () => {
    expect(factPack({ website: { facts } } as never).map((f) => [f.id, f.url])).toEqual([
      ['F1', 'https://exampledrilling.example/about'],
      ['F2', 'https://exampledrilling.example/news'],
    ]);
  });

  it('catches forbidden claims, missing citations and a hypothesis stated as fact', () => {
    const pack = [{ id: 'F1', text: 'x', url: 'u' }];
    expect(checkDraft(['Hope to meet you at ADIPEC next week!'], ['F1'], pack)).toEqual(['claims a meeting at ADIPEC']);
    expect(checkDraft(['As discussed, our partnership…'], ['F1'], pack).sort()).toEqual([
      'claims an earlier conversation',
      'claims an existing relationship',
    ]);
    expect(checkDraft(['fine'], ['F9'], pack)).toEqual(['cites none of the provided facts']);
    expect(checkDraft(['fine'], ['F1'], pack, { hypothesis: 'They have a data problem.' })).toEqual([
      'states the hypothesis as a fact instead of a possibility',
    ]);
    expect(checkDraft(['Saw your news.'], ['F1'], pack, { hypothesis: 'They might benefit.' })).toEqual([]);
  });
});

describe('made-up numbers (BE-4.3)', () => {
  it('flags figures that appear nowhere in what the model was given', () => {
    const pack = [{ id: 'F1', text: 'Runs twelve land rigs since 2004.', url: 'u' }];
    expect(checkDraft(['Since 2004 they have grown fast.'], ['F1'], pack)).toEqual([]);
    expect(checkDraft(['They cut costs by 40% across 1,200 wells.'], ['F1'], pack)).toEqual([
      'uses numbers that aren’t in the facts (40, 1,200)',
    ]);
    expect(checkDraft(['Their 3P pumps impress.'], ['F1'], pack, { known: '3P Prinz' })).toEqual([]);
  });
});

describe('personalization step', () => {
  it('writes no draft for a contact who opted out (BE-4.2)', async () => {
    const { Suppression } = await import('../src/db/models.js');
    const { c, sam, kim } = await setup();
    await Contact.updateOne({ _id: kim._id }, { emails: [{ address: 'kim@optout-ai.example', type: 'business' }] });
    await Suppression.create({ value: 'optout-ai.example' });
    answers.push(goodCompany, goodContact);
    await personalizationStep(job({ companyId: String(c._id) }));
    expect((await Contact.findById(kim._id).lean())?.ai).toMatchObject({ status: 'pending', reason: AI_REASON.optedOut });
    expect((await Contact.findById(sam._id).lean())?.ai?.status).toBe('draft');
    expect(calls).toHaveLength(2); // company + Sam only: Kim's details never went to the model
    expect(calls.join(' ')).not.toContain('Kim');
  });

  it('writes sourced company and contact drafts as new versions, ready for review', async () => {
    const { c, sam, kim } = await setup();
    answers.push(goodCompany, goodContact, goodContact);
    await personalizationStep(job({ companyId: String(c._id) }));

    const after = (await Company.findById(c._id).lean())!;
    expect(after.ai).toMatchObject({
      status: 'draft',
      signal: goodCompany.signal,
      signalUrl: 'https://exampledrilling.example/news', // from our stored fact, not the model
    });
    expect([...after.ai!.evidenceUrls].sort()).toEqual(['https://exampledrilling.example/about', 'https://exampledrilling.example/news']);
    expect(after.ai?.versions?.[0]).toMatchObject({ by: 'ai', fields: { summary: goodCompany.summary } });
    expect(after.stages?.personalization).toMatchObject({ status: 'needs_review', reason: 'Draft ready for review' });
    expect(calls[0]).not.toContain('may expand to Oman'); // inferences never reach the model

    const s = (await Contact.findById(sam._id).lean())!;
    const k = (await Contact.findById(kim._id).lean())!;
    expect(s.ai).toMatchObject({ status: 'draft', subject: goodContact.subject, linkedinDraft: '' }); // no profile link → no LinkedIn draft
    expect(k.ai?.linkedinDraft).toBe(goodContact.linkedinDraft);
  });

  it('retries once with the reasons, then gives up honestly', async () => {
    const { c } = await setup();
    const bad = { ...goodCompany, hyperPersonalization: 'Great meeting you at ADIPEC!' };
    answers.push(bad, goodCompany, goodContact, goodContact);
    await personalizationStep(job({ companyId: String(c._id) }));
    expect(calls[1]).toContain('Your previous answer broke these rules: claims a meeting at ADIPEC');
    expect((await Company.findById(c._id).lean())?.ai?.status).toBe('draft');

    const { c: c2 } = await setup();
    answers.push(bad, bad, goodContact, goodContact);
    await personalizationStep(job({ companyId: String(c2._id) }));
    const after = (await Company.findById(c2._id).lean())!;
    expect(after.ai?.status).toBe('insufficient_evidence');
    expect(after.ai?.reason).toContain('failed the automatic checks (claims a meeting at ADIPEC');
    expect(after.ai?.versions).toEqual([]);
  });

  it('never invents without facts, and never without a model', async () => {
    const { c, sam } = await setup({ website: { facts: [] } });
    await personalizationStep(job({ companyId: String(c._id) }));
    expect((await Company.findById(c._id).lean())?.ai).toMatchObject({ status: 'insufficient_evidence', reason: AI_REASON.noFactsCompany });
    expect((await Contact.findById(sam._id).lean())?.ai?.status).toBe('insufficient_evidence');

    env.LLM_API_KEY = undefined;
    const { c: c2 } = await setup();
    await personalizationStep(job({ companyId: String(c2._id) }));
    const after = (await Company.findById(c2._id).lean())!;
    expect(after.ai).toMatchObject({ status: 'pending', reason: AI_REASON.noModel });
    expect(after.stages?.personalization?.status).toBe('pending_access');
    expect(calls).toHaveLength(0);
  });

  it('keeps an approved draft on a normal run; regenerate makes a new version and keeps the approved copy', async () => {
    const approved = { fields: { summary: 'Approved text' }, by: 'ali@example.com', at: new Date() };
    const { c } = await setup({ ai: { status: 'approved', summary: 'Approved text', approved, versions: [approved] } });
    await Contact.deleteMany({ company: c._id });
    await personalizationStep(job({ companyId: String(c._id) }));
    expect(calls).toHaveLength(0);

    answers.push(goodCompany);
    await personalizationStep(job({ companyId: String(c._id), force: true }));
    const after = (await Company.findById(c._id).lean())!;
    expect(after.ai?.status).toBe('draft');
    expect(after.ai?.approved?.fields).toEqual({ summary: 'Approved text' });
    expect(after.ai?.versions).toHaveLength(2);
  });

  it('a refusal or rejected key leaves it pending with the reason', async () => {
    const { c } = await setup();
    answers.push(new LlmStop('The AI model declined to write this draft'));
    await personalizationStep(job({ companyId: String(c._id) }));
    expect((await Company.findById(c._id).lean())?.ai).toMatchObject({
      status: 'pending',
      reason: 'The AI model declined to write this draft',
    });
  });

  it('a contact-only job leaves the company step alone', async () => {
    const { c, sam } = await setup();
    answers.push(goodContact);
    await personalizationStep(job({ companyId: String(c._id), contactId: String(sam._id) }));
    expect((await Contact.findById(sam._id).lean())?.ai?.status).toBe('draft');
    expect((await Company.findById(c._id).lean())?.stages?.personalization?.status).toBe('not_started');
  });
});
