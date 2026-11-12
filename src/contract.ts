// Copy of the API contract types from PLAN.md. Mappers in db/mappers.ts must return exactly these shapes.
// Change PLAN.md (both repos) first, then this file.
// ---------- enums ----------
export type StepKey = 'profile' | 'website' | 'social' | 'account' | 'people' | 'emails' | 'verification' | 'personalization';
export type StepStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'partial'
  | 'needs_review'
  | 'pending_access'
  | 'restricted'
  | 'failed'
  | 'approved';
export type EmailStatus = 'verified' | 'invalid' | 'risky' | 'unknown' | 'not_checked';
export type AiStatus = 'pending' | 'insufficient_evidence' | 'draft' | 'approved' | 'rejected';
export type Coverage = 'confirmed_partial' | 'unknown' | 'reviewed';
export type Confidence = 'high' | 'medium' | 'low';
export type Role = 'admin' | 'reviewer';
export type ReviewType = 'website' | 'duplicate' | 'salesnav' | 'contacts' | 'emails' | 'ai';
export type ExportKind = 'companies' | 'contacts' | 'outreach';

// ---------- shared ----------
export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };
export type StepState = { status: StepStatus; reason?: string; updatedAt?: string };
export type Fact = { text: string; sourceUrl: string; kind: 'fact' | 'inference' };

// ---------- users ----------
export type User = { id: string; email: string; role: Role; createdAt: string };

// ---------- events ----------
export type Event = { id: string; edition: number; name: string; directoryUrl: string; advertisedCount?: number };

// ---------- companies ----------
export type Edition = {
  edition: number;
  profileUrl: string;
  stand?: string;
  category?: string;
  country?: string;
  description?: string;
  extra?: Record<string, string>;
  capturedAt: string;
};

export type CompanyListItem = {
  id: string;
  name: string;
  domain?: string;
  country?: string;
  category?: string;
  stand?: string;
  editions: number[];
  stages: Record<StepKey, StepState>;
  contactsCount: number;
  emailsByStatus: Partial<Record<EmailStatus, number>>;
  aiStatus: AiStatus;
  duplicateOf?: string;
  completeness: number; // 0–100
  updatedAt: string;
};

export type Company = Omit<CompanyListItem, 'editions'> & {
  originalNames: string[];
  editions: Edition[];
  website: {
    url?: string;
    summary?: string;
    services: string[];
    markets: string[];
    contactDetails: { emails: string[]; phones: string[]; addresses: string[]; sourceUrl?: string };
    pagesReviewed: { url: string; fetchedAt: string }[];
    skipped: { url: string; reason: string }[];
    facts: Fact[];
  };
  socials: { linkedin?: string; facebook?: string; instagram?: string; x?: string; youtube?: string; other: string[] };
  salesNav: { accountUrl?: string; matchConfidence?: Confidence; searchUrl: string };
  leadershipCoverage: Coverage;
  lockedFields: string[]; // fields a human edited; workers won't overwrite them
  ai: CompanyAi;
  contacts: Contact[];
};

export type CompanyFilters = {
  q?: string;
  edition?: number;
  category?: string;
  country?: string;
  step?: StepKey;
  stepStatus?: StepStatus;
  hasContacts?: boolean;
  emailStatus?: EmailStatus;
  aiStatus?: AiStatus;
  duplicate?: boolean;
  sort?: 'name' | '-name' | 'updatedAt' | '-updatedAt' | 'completeness' | '-completeness';
};

// ---------- contacts ----------
export type Email = {
  address: string;
  type?: 'business' | 'generic';
  provider?: string;
  capturedAt: string;
  verification: { status: EmailStatus; checkedAt?: string; source?: string };
};

export type Contact = {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  title?: string;
  seniority?: string;
  profileUrl?: string;
  geography?: string;
  matchConfidence?: Confidence;
  source: string; // 'manual' | 'csv_import' | 'contactout' | ...
  emails: Email[];
  ai: ContactAi;
  createdAt: string;
  updatedAt: string;
};

export type ContactInput = {
  firstName: string;
  lastName: string;
  title?: string;
  seniority?: string;
  profileUrl?: string;
  geography?: string;
  matchConfidence?: Confidence;
  source: string;
  emails?: { address: string; type?: 'business' | 'generic'; provider?: string }[];
};

// ---------- AI ----------
export type AiVersion = { fields: Record<string, string>; by: string; at: string };

export type CompanyAi = {
  status: AiStatus;
  reason?: string;
  summary?: string;
  signal?: string;
  signalUrl?: string;
  hypothesis?: string;
  hyperPersonalization?: string;
  evidenceUrls: string[];
  approved?: AiVersion; // last approved copy; exports prefer this
  versions: AiVersion[]; // newest first
};

export type ContactAi = {
  status: AiStatus;
  reason?: string;
  subject?: string;
  draft?: string;
  linkedinDraft?: string;
  evidenceUrls: string[];
  approved?: AiVersion;
  versions: AiVersion[];
};

// ---------- runs ----------
export type Run = {
  id: string;
  edition: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
  steps: (StepKey | 'directory')[];
  startedBy: string;
  createdAt: string;
  finishedAt?: string;
  counts: {
    discovered: number;
    attempted: number;
    completed: number;
    partial: number;
    restricted: number;
    failed: number;
    duplicate: number;
  };
  perStep: Record<string, { queued: number; done: number; failed: number }>;
  errors: { companyId?: string; companyName?: string; step: string; message: string; at: string }[]; // last 100
};

// ---------- review / reports ----------
export type ReviewItem = {
  type: ReviewType;
  companyId: string;
  companyName: string;
  contactId?: string;
  contactName?: string;
  reason: string;
  since: string;
};

export type Overview = {
  edition: number;
  advertised?: number;
  discovered: number;
  unique: number;
  duplicates: number;
  byStep: Record<StepKey, Partial<Record<StepStatus, number>>>;
  contacts: number;
  companiesWithContacts: number;
  emailsByStatus: Record<EmailStatus, number>;
  ai: Record<AiStatus, number>;
  failures: number;
};

export type GapReport = {
  edition: number;
  generatedAt: string;
  advertised?: number;
  discovered: number;
  researched: number;
  contactsFound: number;
  emailsChecked: number;
  aiDone: number;
  byStep: Record<StepKey, Partial<Record<StepStatus, number>>>;
  blocked: { companyId: string; companyName: string; step: StepKey; status: StepStatus; reason?: string }[];
};

export type HistoryEntry = { field: string; before: unknown; after: unknown; by: string; at: string };
export type ExportLogEntry = {
  id: string;
  kind: ExportKind;
  version: 'initial' | 'final';
  filters: CompanyFilters;
  rows: number;
  by: string;
  at: string;
};
export type Providers = { contactout: boolean; millionverifier: boolean; llm: boolean; llmModel?: string };
export type Suppression = { id: string; value: string; reason?: string; at: string };
