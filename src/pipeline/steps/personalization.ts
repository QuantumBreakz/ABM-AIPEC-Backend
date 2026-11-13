/**
 * Step — AI research notes and outreach drafts (PTC §5, FR-23…31).
 *
 * Company level (runs even with no contacts, FR-24): summary, signal + its URL, hypothesis, hyper-personalization.
 * Contact level: subject line, email draft, LinkedIn draft (only when we have their profile link).
 *
 * How we keep it honest:
 *  - The model only sees facts we saved from the company's website, each with an id (F1, F2…).
 *    It must cite ids; the signal URL comes from our stored fact, so it can't invent a source (FR-27).
 *  - Hard checks on every answer: no claims of meeting at ADIPEC, past conversations, partnerships or interest
 *    (FR-29), hypothesis written as a possibility (FR-28). A failing answer gets one retry with the reasons.
 *  - No sourced facts → "insufficient evidence", nothing generated. No AI key → "pending" (FR-31).
 *  - Each result is a new version; the approved copy is never touched (FR-30).
 */
import type { Job } from 'bullmq';
import { z } from 'zod';
import { setStep } from '../../db/helpers.js';
import { Company, type CompanyDoc, Contact, type ContactDoc } from '../../db/models.js';
import { suppressedOf } from '../../lib/suppression.js';
import { AI_REASON, generateJson, LlmStop, llmEnabled } from '../../providers/llm.js';
import type { JobData } from '../queue.js';
import { continueAfter } from '../runs.js';

export type PackFact = { id: string; text: string; url: string };

/** The facts the model may use: sourced website facts only (no inferences), numbered F1… */
export function factPack(company: Pick<CompanyDoc, 'website'>): PackFact[] {
  return (company.website?.facts ?? [])
    .filter((f) => f.kind !== 'inference' && f.text && f.sourceUrl)
    .slice(0, 20)
    .map((f, i) => ({ id: `F${i + 1}`, text: f.text!, url: f.sourceUrl! }));
}

const SMART_LOGICS = 'Smart Logics builds custom software and AI systems for companies.';
const NEVER =
  'Never claim or suggest that we met, spoke, or will meet at ADIPEC or anywhere else, that there was an earlier conversation, an existing relationship or partnership, or that they showed interest. Never add numbers, clients, problems, budgets or events that are not in the facts.';

const COMPANY_SYSTEM = `You write short research notes about exhibitors at ADIPEC, an energy exhibition, for sales researchers at Smart Logics. ${SMART_LOGICS}
Use only the facts provided. Each fact has an id like F1. ${NEVER}
- summary: 2 to 5 plain sentences on what the company does.
- signalFactId: the id of the single most specific fact (a product, service, project or news item) to open a conversation with. signal: one sentence restating that fact.
- hypothesis: one sentence on a workflow where custom software or AI might help them. Write it as a possibility (may, might, could), never as a known problem.
- hyperPersonalization: 1 to 3 sentences that could open an email, grounded only in the facts you cite.
- citedFactIds: the ids of every fact you relied on.`;

const CONTACT_SYSTEM = `You write first-contact outreach drafts from Smart Logics to a person at an ADIPEC exhibitor. ${SMART_LOGICS}
Use only the facts provided about their company and the person's name and role. Each fact has an id like F1. ${NEVER}
- subject: a short subject line (under 10 words) specific to their company.
- draft: a concise, professional email under 120 words that refers to one cited fact and asks one genuine question. No hard sell. End with "Best regards," and no name.
- linkedinDraft: a message under 300 characters for LinkedIn, or an empty string if the person has no profile link.
- citedFactIds: the ids of every fact you relied on.`;

const companySchema = z.object({
  summary: z.string(),
  signalFactId: z.string(),
  signal: z.string(),
  hypothesis: z.string(),
  hyperPersonalization: z.string(),
  citedFactIds: z.array(z.string()),
});
const contactSchema = z.object({ subject: z.string(), draft: z.string(), linkedinDraft: z.string(), citedFactIds: z.array(z.string()) });

const BANNED: [RegExp, string][] = [
  [/\b(met|meet|meeting|spoke|speaking|chatted|see you|catch up)\b[^.]{0,40}\badipec\b/i, 'claims a meeting at ADIPEC'],
  [/\badipec\b[^.]{0,40}\b(met|meeting|spoke|conversation|chat)\b/i, 'claims a meeting at ADIPEC'],
  [
    /\b(as (we )?discussed|following (up on )?our (call|conversation|chat|meeting)|great (to|meeting) (meet|you|speak))/i,
    'claims an earlier conversation',
  ],
  [/\bour (existing |ongoing |long-standing )?(partnership|collaboration|relationship)\b/i, 'claims an existing relationship'],
  [/\byou(r team)? (expressed|showed|shared|mentioned) (an )?interest\b/i, 'claims they showed interest'],
];

const NUMBER = /\d(?:[\d,.]*\d)?/g;
const digitsOnly = (n: string) => n.replace(/[,.]/g, '');

/**
 * Problems with a generated answer, in plain words. Empty = OK.
 * `known` is everything we gave the model; any number it writes must appear there (no made-up figures).
 */
export function checkDraft(
  texts: string[],
  cited: string[],
  pack: PackFact[],
  opts: { hypothesis?: string; known?: string } = {},
): string[] {
  const problems = new Set<string>();
  for (const t of texts) for (const [re, why] of BANNED) if (re.test(t)) problems.add(why);
  const known = new Set((`${opts.known ?? ''} ${pack.map((f) => f.text).join(' ')}`.match(NUMBER) ?? []).map(digitsOnly));
  const invented = texts.flatMap((t) => t.match(NUMBER) ?? []).filter((n) => !known.has(digitsOnly(n)));
  if (invented.length) problems.add(`uses numbers that aren’t in the facts (${[...new Set(invented)].join(', ')})`);
  const ids = new Set(pack.map((f) => f.id));
  if (!cited.some((c) => ids.has(c))) problems.add('cites none of the provided facts');
  if (opts.hypothesis !== undefined && !/\b(may|might|could|possibly|perhaps|likely)\b/i.test(opts.hypothesis)) {
    problems.add('states the hypothesis as a fact instead of a possibility');
  }
  return [...problems];
}

/** Everything the model is shown about the company, as one string (used to spot made-up numbers). */
const knownText = (company: CompanyDoc) => {
  const latest = [...company.editions].sort((a, b) => b.edition - a.edition)[0];
  return [
    company.name,
    latest?.description,
    company.website?.summary,
    ...(company.website?.services ?? []),
    ...(company.website?.markets ?? []),
  ].join(' ');
};

const prompt = (company: CompanyDoc, pack: PackFact[], extra = '') => {
  const latest = [...company.editions].sort((a, b) => b.edition - a.edition)[0];
  return JSON.stringify(
    {
      company: company.name,
      adipecDescription: latest?.description ?? null,
      websiteSummary: company.website?.summary ?? null,
      services: company.website?.services ?? [],
      markets: company.website?.markets ?? [],
      facts: pack,
    },
    null,
    1,
  ).concat(extra);
};

/** Ask, check, and retry once with the reasons if the answer breaks a rule. */
async function generateChecked<S extends z.ZodType>(
  system: string,
  input: string,
  schema: S,
  check: (out: z.infer<S>) => string[],
): Promise<{ out: z.infer<S> } | { problems: string[] }> {
  let out = await generateJson(system, input, schema);
  let problems = check(out);
  if (problems.length) {
    out = await generateJson(
      system,
      `${input}\n\nYour previous answer broke these rules: ${problems.join('; ')}. Write it again following every rule.`,
      schema,
    );
    problems = check(out);
  }
  return problems.length ? { problems } : { out };
}

const urlsOf = (ids: string[], pack: PackFact[]) => [...new Set(pack.filter((f) => ids.includes(f.id)).map((f) => f.url))];

function version(fields: Record<string, string>) {
  return { $push: { 'ai.versions': { $each: [{ fields, by: 'ai', at: new Date() }], $position: 0 } } };
}

async function draftCompany(company: CompanyDoc, pack: PackFact[]) {
  const r = await generateChecked(COMPANY_SYSTEM, prompt(company, pack), companySchema, (o) =>
    checkDraft([o.summary, o.signal, o.hypothesis, o.hyperPersonalization], [o.signalFactId, ...o.citedFactIds], pack, {
      known: knownText(company),
      hypothesis: o.hypothesis,
    }),
  );
  if ('problems' in r) {
    const reason = `The AI draft failed the automatic checks (${r.problems.join('; ')}), so nothing was saved.`;
    await Company.updateOne({ _id: company._id }, { $set: { 'ai.status': 'insufficient_evidence', 'ai.reason': reason } });
    return { ok: false, reason };
  }
  const o = r.out;
  const signalFact = pack.find((f) => f.id === o.signalFactId) ?? pack.find((f) => o.citedFactIds.includes(f.id))!;
  const fields = {
    summary: o.summary,
    signal: o.signal,
    signalUrl: signalFact.url,
    hypothesis: o.hypothesis,
    hyperPersonalization: o.hyperPersonalization,
  };
  const evidence = urlsOf([o.signalFactId, ...o.citedFactIds], pack);
  await Company.updateOne(
    { _id: company._id },
    {
      $set: {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`ai.${k}`, v])),
        'ai.evidenceUrls': evidence,
        'ai.status': 'draft',
      },
      $unset: { 'ai.reason': 1 },
      ...version(fields),
    },
  );
  return { ok: true };
}

async function draftContact(company: CompanyDoc, contact: ContactDoc, pack: PackFact[]) {
  const person = `\n\nPerson: ${JSON.stringify({ firstName: contact.firstName, lastName: contact.lastName, title: contact.title ?? null, seniority: contact.seniority ?? null, hasProfileLink: !!contact.profileUrl })}`;
  const r = await generateChecked(CONTACT_SYSTEM, prompt(company, pack, person), contactSchema, (o) =>
    checkDraft([o.subject, o.draft, o.linkedinDraft], o.citedFactIds, pack, { known: `${knownText(company)} ${contact.title ?? ''}` }),
  );
  if ('problems' in r) {
    await Contact.updateOne(
      { _id: contact._id },
      {
        $set: {
          'ai.status': 'insufficient_evidence',
          'ai.reason': `The AI draft failed the automatic checks (${r.problems.join('; ')}), so nothing was saved.`,
        },
      },
    );
    return;
  }
  const o = r.out;
  const fields = { subject: o.subject, draft: o.draft, linkedinDraft: contact.profileUrl ? o.linkedinDraft : '' };
  await Contact.updateOne(
    { _id: contact._id },
    {
      $set: {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`ai.${k}`, v])),
        'ai.evidenceUrls': urlsOf(o.citedFactIds, pack),
        'ai.status': 'draft',
      },
      $unset: { 'ai.reason': 1 },
      ...version(fields),
    },
  );
}

type AiState = 'pending' | 'insufficient_evidence';
const setCompanyAi = (id: unknown, status: AiState, reason: string) =>
  Company.updateOne({ _id: id }, { $set: { 'ai.status': status, 'ai.reason': reason } });
const setContactsAi = (filter: Record<string, unknown>, status: AiState, reason: string) =>
  Contact.updateMany(filter, { $set: { 'ai.status': status, 'ai.reason': reason } });

export async function personalizationStep(job: Job<JobData>) {
  const { companyId, contactId, runId, force } = job.data;
  const company = await Company.findById(companyId).lean();
  if (!company) return;
  const id = String(company._id);
  const companyLevel = !contactId;
  const people = await Contact.find(contactId ? { _id: contactId, company: company._id } : { company: company._id }).lean();
  // Opted-out people get no draft (PTC §8.2). A normal run also leaves approved drafts alone;
  // "regenerate" (force) always writes a new version.
  const blocked = await suppressedOf(people.flatMap((p) => p.emails.map((e) => e.address)));
  const optedOut = people.filter((p) => p.emails.some((e) => blocked.has(e.address)));
  if (optedOut.length) await setContactsAi({ _id: { $in: optedOut.map((p) => p._id) } }, 'pending', AI_REASON.optedOut);
  const todo = people.filter((p) => !optedOut.includes(p) && (force || p.ai?.status !== 'approved'));

  const finish = async (status: 'needs_review' | 'pending_access', reason: string) => {
    if (!companyLevel) return;
    await setStep(id, 'personalization', status, reason);
    await continueAfter('personalization', id, runId);
  };

  if (!llmEnabled()) {
    if (companyLevel) await setCompanyAi(company._id, 'pending', AI_REASON.noModel);
    await setContactsAi({ _id: { $in: todo.map((p) => p._id) } }, 'pending', AI_REASON.noModel);
    return finish('pending_access', AI_REASON.noModel);
  }

  const pack = factPack(company);
  if (!pack.length) {
    if (companyLevel) await setCompanyAi(company._id, 'insufficient_evidence', AI_REASON.noFactsCompany);
    await setContactsAi({ _id: { $in: todo.map((p) => p._id) } }, 'insufficient_evidence', AI_REASON.noFactsContact);
    return finish('needs_review', AI_REASON.noFactsCompany);
  }

  try {
    let note = 'Draft ready for review';
    if (companyLevel && (force || company.ai?.status !== 'approved')) {
      const r = await draftCompany(company, pack);
      if (!r.ok) note = r.reason!;
    }
    for (const p of todo) await draftContact(company, p, pack);
    return finish('needs_review', note);
  } catch (e) {
    if (!(e instanceof LlmStop)) throw e; // rate limit / outage: BullMQ retries
    // The service said no (refusal, bad key…): keep it pending with the reason, never fake a draft (FR-31).
    if (companyLevel) await setCompanyAi(company._id, 'pending', e.message);
    await setContactsAi({ _id: { $in: todo.map((p) => p._id) }, 'ai.status': { $ne: 'draft' } }, 'pending', e.message);
    return finish('pending_access', e.message);
  }
}
