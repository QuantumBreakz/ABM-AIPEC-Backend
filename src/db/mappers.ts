// Database documents → API contract shapes. If a type error shows up here, the API and the contract have drifted.
import type * as C from '../contract.js';
import { type CompanyDoc, type ContactDoc, type EventDoc, type RunDoc, STEPS } from './models.js';

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);
const str = (s?: string | null) => s ?? undefined;
const plain = (m: unknown): Record<string, string> =>
  m instanceof Map ? Object.fromEntries(m) : ((m as Record<string, string> | undefined | null) ?? {});

type Edition = CompanyDoc['editions'][number];

/** One edition can have several listings (stands); merge them into one line for list views. */
function editionSummary(editions: Edition[], edition?: number) {
  const target = edition ?? Math.max(...editions.map((e) => e.edition), 0);
  const rows = editions.filter((e) => e.edition === target);
  const join = (k: 'stand' | 'country' | 'category') => [...new Set(rows.map((r) => r[k]).filter(Boolean))].join(', ') || undefined;
  return { stand: join('stand'), country: join('country'), category: join('category') };
}

function stages(doc: CompanyDoc): Record<C.StepKey, C.StepState> {
  return Object.fromEntries(
    STEPS.map((s) => {
      const st = (doc.stages as any)?.[s] ?? {};
      return [s, { status: st.status ?? 'not_started', reason: str(st.reason), updatedAt: iso(st.updatedAt) }];
    }),
  ) as Record<C.StepKey, C.StepState>;
}

const aiVersion = (v: any): C.AiVersion | undefined => (v?.at ? { fields: v.fields ?? {}, by: v.by, at: iso(v.at)! } : undefined);

export function toListItem(doc: CompanyDoc, emailCounts: C.CompanyListItem['emailsByStatus'] = {}, edition?: number): C.CompanyListItem {
  return {
    id: String(doc._id),
    name: doc.name,
    domain: str(doc.domain),
    ...editionSummary(doc.editions, edition),
    editions: [...new Set(doc.editions.map((e) => e.edition))].sort(),
    stages: stages(doc),
    contactsCount: doc.contactsCount ?? 0,
    emailsByStatus: emailCounts,
    aiStatus: doc.ai?.status ?? 'pending',
    duplicateOf: doc.duplicateOf ? String(doc.duplicateOf) : undefined,
    completeness: doc.completeness ?? 0,
    updatedAt: iso(doc.updatedAt)!,
  };
}

const versions = (vs?: unknown[] | null) => (vs ?? []).map(aiVersion).filter((v): v is C.AiVersion => !!v);

export const toCompanyAi = (ai: CompanyDoc['ai'] | undefined): C.CompanyAi => ({
  status: ai?.status ?? 'pending',
  reason: str(ai?.reason),
  summary: str(ai?.summary),
  signal: str(ai?.signal),
  signalUrl: str(ai?.signalUrl),
  hypothesis: str(ai?.hypothesis),
  hyperPersonalization: str(ai?.hyperPersonalization),
  evidenceUrls: ai?.evidenceUrls ?? [],
  approved: aiVersion(ai?.approved),
  versions: versions(ai?.versions),
});

export const toContactAi = (ai: ContactDoc['ai'] | undefined): C.ContactAi => ({
  status: ai?.status ?? 'pending',
  reason: str(ai?.reason),
  subject: str(ai?.subject),
  draft: str(ai?.draft),
  linkedinDraft: str(ai?.linkedinDraft),
  evidenceUrls: ai?.evidenceUrls ?? [],
  approved: aiVersion(ai?.approved),
  versions: versions(ai?.versions),
});

export function toContact(c: ContactDoc): C.Contact {
  return {
    id: String(c._id),
    companyId: String(c.company),
    firstName: c.firstName,
    lastName: c.lastName,
    title: str(c.title),
    seniority: str(c.seniority),
    profileUrl: str(c.profileUrl),
    geography: str(c.geography),
    matchConfidence: str(c.matchConfidence) as C.Confidence | undefined,
    source: c.source,
    emails: c.emails.map((e) => ({
      address: e.address,
      type: str(e.type) as C.Email['type'],
      provider: str(e.provider),
      capturedAt: iso(e.capturedAt)!,
      verification: {
        status: e.verification?.status ?? 'not_checked',
        checkedAt: iso(e.verification?.checkedAt),
        source: str(e.verification?.source),
      },
    })),
    ai: toContactAi(c.ai),
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
  };
}

export function emailCountsOf(contacts: ContactDoc[]) {
  const counts: Partial<Record<C.EmailStatus, number>> = {};
  for (const c of contacts)
    for (const e of c.emails) counts[e.verification?.status ?? 'not_checked'] = (counts[e.verification?.status ?? 'not_checked'] ?? 0) + 1;
  return counts;
}

export function toCompany(doc: CompanyDoc, contacts: ContactDoc[]): C.Company {
  const { editions: _, ...item } = toListItem(doc, emailCountsOf(contacts));
  const w = doc.website ?? ({} as CompanyDoc['website']);
  const s = doc.socials ?? ({} as CompanyDoc['socials']);
  return {
    ...item,
    originalNames: doc.originalNames ?? [],
    editions: [...doc.editions]
      .sort((a, b) => b.edition - a.edition)
      .map((e) => ({
        edition: e.edition,
        profileUrl: e.profileUrl ?? '',
        stand: str(e.stand),
        category: str(e.category),
        country: str(e.country),
        description: str(e.description),
        extra: plain(e.extra),
        capturedAt: iso(e.capturedAt)!,
      })),
    website: {
      url: str(w?.url),
      summary: str(w?.summary),
      services: w?.services ?? [],
      markets: w?.markets ?? [],
      contactDetails: {
        emails: w?.contactDetails?.emails ?? [],
        phones: w?.contactDetails?.phones ?? [],
        addresses: w?.contactDetails?.addresses ?? [],
        sourceUrl: str(w?.contactDetails?.sourceUrl),
      },
      pagesReviewed: (w?.pagesReviewed ?? []).map((p) => ({ url: p.url!, fetchedAt: iso(p.fetchedAt)! })),
      skipped: (w?.skipped ?? []).map((p) => ({ url: p.url!, reason: p.reason ?? '' })),
      facts: (w?.facts ?? []).map((f) => ({ text: f.text!, sourceUrl: f.sourceUrl!, kind: (f.kind ?? 'fact') as C.Fact['kind'] })),
    },
    socials: {
      linkedin: str(s?.linkedin),
      facebook: str(s?.facebook),
      instagram: str(s?.instagram),
      x: str(s?.x),
      youtube: str(s?.youtube),
      other: s?.other ?? [],
    },
    salesNav: {
      accountUrl: str(doc.salesNav?.accountUrl),
      matchConfidence: str(doc.salesNav?.matchConfidence) as C.Confidence | undefined,
      // Just a link a person opens. The system never visits LinkedIn (NFR-07).
      searchUrl: `https://www.linkedin.com/sales/search/company?keywords=${encodeURIComponent(doc.name)}`,
    },
    leadershipCoverage: doc.leadershipCoverage ?? 'unknown',
    lockedFields: doc.lockedFields ?? [],
    ai: toCompanyAi(doc.ai),
    contacts: contacts.map(toContact),
  };
}

export const toUser = (u: { _id: unknown; email: string; role?: string | null; createdAt?: Date }): C.User => ({
  id: String(u._id),
  email: u.email,
  role: (u.role ?? 'reviewer') as C.Role,
  createdAt: iso(u.createdAt)!,
});

export const toEvent = (e: Pick<EventDoc, '_id' | 'edition' | 'name' | 'directoryUrl' | 'advertisedCount'>): C.Event => ({
  id: String(e._id),
  edition: e.edition,
  name: e.name,
  directoryUrl: e.directoryUrl,
  advertisedCount: e.advertisedCount ?? undefined,
});

export type RunSummary = Pick<C.Run, 'counts' | 'perStep'>;

export const toRun = (r: RunDoc, summary: RunSummary): C.Run => ({
  id: String(r._id),
  edition: r.edition,
  status: r.status as C.Run['status'],
  steps: r.steps as C.Run['steps'],
  startedBy: r.startedBy ?? 'system',
  createdAt: iso(r.createdAt)!,
  finishedAt: iso(r.finishedAt),
  ...summary,
  errors: [...(r.errors ?? [])].reverse().map((e) => ({
    // newest first
    companyId: str(e.companyId),
    companyName: str(e.companyName),
    step: e.step ?? '',
    message: e.message ?? '',
    at: iso(e.at)!,
  })),
});
