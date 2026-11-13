// MongoDB collections. The API never returns these documents directly: db/mappers.ts turns them into contract shapes.
import { model, Schema, Types } from 'mongoose';
import type { AiStatus, Confidence, Coverage, EmailStatus, ExportKind, Role, StepKey, StepStatus } from '../contract.js';

// ---------- enums (runtime copies of the contract unions) ----------
export const STEPS = [
  'profile',
  'website',
  'social',
  'account',
  'people',
  'emails',
  'verification',
  'personalization',
] as const satisfies readonly StepKey[];
export const STATUSES = [
  'not_started',
  'in_progress',
  'completed',
  'partial',
  'needs_review',
  'pending_access',
  'restricted',
  'failed',
  'approved',
] as const satisfies readonly StepStatus[];
export const EMAIL_STATUSES = ['verified', 'invalid', 'risky', 'unknown', 'not_checked'] as const satisfies readonly EmailStatus[];
export const AI_STATUSES = ['pending', 'insufficient_evidence', 'draft', 'approved', 'rejected'] as const satisfies readonly AiStatus[];
export const COVERAGE = ['confirmed_partial', 'unknown', 'reviewed'] as const satisfies readonly Coverage[];
export const CONFIDENCE = ['high', 'medium', 'low'] as const satisfies readonly Confidence[];
export const ROLES = ['admin', 'reviewer'] as const satisfies readonly Role[];
export const EXPORT_KINDS = ['companies', 'contacts', 'outreach'] as const satisfies readonly ExportKind[];

const opts = { _id: false } as const;

// ---------- small reusable pieces ----------
const stepState = new Schema({ status: { type: String, enum: STATUSES, default: 'not_started' }, reason: String, updatedAt: Date }, opts);
const stages = new Schema(Object.fromEntries(STEPS.map((s) => [s, { type: stepState, default: () => ({}) }])), opts);
const fact = new Schema({ text: String, sourceUrl: String, kind: { type: String, enum: ['fact', 'inference'] } }, opts);
const aiVersion = new Schema(
  { fields: { type: Schema.Types.Mixed, default: {} }, by: String, at: { type: Date, default: Date.now } },
  opts,
);

// ---------- events ----------
const eventSchema = new Schema(
  {
    edition: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    directoryUrl: { type: String, required: true },
    advertisedCount: Number,
    // ADIPEC product-category id → "O&G > Upstream > Wells". Filled by the directory step, used by the profile step.
    categoryPaths: { type: Map, of: String, default: () => new Map() },
  },
  { timestamps: true },
);
export const Event = model('Event', eventSchema);

// ---------- companies ----------
const editionSchema = new Schema(
  {
    edition: { type: Number, required: true },
    sourceId: { type: String, required: true }, // ADIPEC exhibitor id; one company can have several listings
    profileUrl: String,
    stand: String,
    category: String,
    country: String,
    description: String,
    extra: { type: Map, of: String, default: () => new Map() },
    capturedAt: Date,
  },
  opts,
);

const companySchema = new Schema(
  {
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    originalNames: { type: [String], default: [] },
    domain: String,
    editions: { type: [editionSchema], default: [] },
    website: {
      url: String,
      summary: String,
      services: { type: [String], default: [] },
      markets: { type: [String], default: [] },
      contactDetails: {
        emails: { type: [String], default: [] },
        phones: { type: [String], default: [] },
        addresses: { type: [String], default: [] },
        sourceUrl: String,
      },
      pagesReviewed: { type: [new Schema({ url: String, fetchedAt: Date }, opts)], default: [] },
      skipped: { type: [new Schema({ url: String, reason: String }, opts)], default: [] },
      facts: { type: [fact], default: [] },
    },
    socials: {
      linkedin: String,
      facebook: String,
      instagram: String,
      x: String,
      youtube: String,
      other: { type: [String], default: [] },
    },
    salesNav: { accountUrl: String, matchConfidence: { type: String, enum: CONFIDENCE } },
    leadershipCoverage: { type: String, enum: COVERAGE, default: 'unknown' },
    stages: { type: stages, default: () => ({}) },
    ai: {
      status: { type: String, enum: AI_STATUSES, default: 'pending' },
      reason: String,
      summary: String,
      signal: String,
      signalUrl: String,
      hypothesis: String,
      hyperPersonalization: String,
      evidenceUrls: { type: [String], default: [] },
      approved: aiVersion,
      versions: { type: [aiVersion], default: [] },
    },
    duplicateOf: { type: Types.ObjectId, ref: 'Company' }, // flagged as a possible duplicate of this company, until a person decides
    duplicateReason: String,
    notDuplicateOf: { type: [Types.ObjectId], default: [] }, // a person said "not a duplicate"; never flag this pair again
    lockedFields: { type: [String], default: [] }, // set by saveWithHistory when a person edits a field
    // Denormalised from contacts so the list can filter/sort without joins. Kept fresh by refreshContactStats().
    contactsCount: { type: Number, default: 0 },
    emailStatuses: { type: [String], enum: EMAIL_STATUSES, default: [] },
    completeness: { type: Number, default: 0 },
  },
  { timestamps: true },
);
companySchema.index({ normalizedName: 1 }, { unique: true });
companySchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { domain: { $type: 'string' } } });
companySchema.index({ 'editions.edition': 1 });
companySchema.index({ 'editions.edition': 1, 'editions.sourceId': 1 });
companySchema.index({ updatedAt: -1 });
export const Company = model('Company', companySchema);

// ---------- contacts ----------
const emailSchema = new Schema(
  {
    address: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: ['business', 'generic'] },
    provider: String,
    providerStatus: String, // what the provider said (e.g. ContactOut "Verified"); not our own verification
    capturedAt: { type: Date, default: Date.now },
    verification: {
      status: { type: String, enum: EMAIL_STATUSES, default: 'not_checked' },
      checkedAt: Date,
      source: String,
    },
  },
  opts,
);

const contactSchema = new Schema(
  {
    company: { type: Types.ObjectId, ref: 'Company', required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    title: String,
    seniority: String,
    profileUrl: String,
    geography: String,
    matchConfidence: { type: String, enum: CONFIDENCE },
    source: { type: String, required: true },
    emails: { type: [emailSchema], default: [] },
    ai: {
      status: { type: String, enum: AI_STATUSES, default: 'pending' },
      reason: String,
      subject: String,
      draft: String,
      linkedinDraft: String,
      evidenceUrls: { type: [String], default: [] },
      approved: aiVersion,
      versions: { type: [aiVersion], default: [] },
    },
  },
  { timestamps: true },
);
contactSchema.index({ company: 1, profileUrl: 1 }, { unique: true, partialFilterExpression: { profileUrl: { $type: 'string' } } });
export const Contact = model('Contact', contactSchema);

// ---------- runs ----------
const runSchema = new Schema(
  {
    edition: { type: Number, required: true },
    status: { type: String, enum: ['running', 'paused', 'completed', 'failed'], default: 'running' },
    steps: { type: [String], required: true },
    startedBy: String,
    directoryDone: { type: Boolean, default: false },
    discovered: { type: Number, default: 0 }, // listings found in the directory for this edition
    duplicates: { type: Number, default: 0 }, // listings that turned out to be a company we already had
    errors: {
      type: [
        new Schema({ companyId: String, companyName: String, step: String, message: String, at: { type: Date, default: Date.now } }, opts),
      ],
      default: [],
    },
    finishedAt: Date,
  },
  { timestamps: true, suppressReservedKeysWarning: true }, // `errors` clashes with a Mongoose internal name; harmless here
);
runSchema.index({ status: 1 });
export const Run = model('Run', runSchema);

// ---------- history (who changed what) ----------
export const History = model(
  'History',
  new Schema({
    entity: { type: String, required: true },
    entityId: { type: Types.ObjectId, required: true },
    field: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    by: { type: String, required: true },
    at: { type: Date, default: Date.now },
  }).index({ entityId: 1, at: -1 }),
);

// ---------- users ----------
export const User = model(
  'User',
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
      role: { type: String, enum: ROLES, default: 'reviewer' },
    },
    { timestamps: true },
  ),
);

// ---------- suppressions (opt-outs) ----------
export const Suppression = model(
  'Suppression',
  new Schema({
    value: { type: String, required: true, unique: true, lowercase: true, trim: true },
    reason: String,
    at: { type: Date, default: Date.now },
  }),
);

// ---------- paid-provider usage (hard monthly caps, so nothing can overspend) ----------
export const Usage = model(
  'Usage',
  new Schema({
    provider: { type: String, required: true },
    period: { type: String, required: true }, // "2026-11"
    count: { type: Number, default: 0 },
  }).index({ provider: 1, period: 1 }, { unique: true }),
);

// ---------- export log ----------
export const ExportLog = model(
  'ExportLog',
  new Schema({
    kind: { type: String, enum: EXPORT_KINDS, required: true },
    version: { type: String, enum: ['initial', 'final'], required: true },
    filters: { type: Schema.Types.Mixed, default: {} },
    rows: Number,
    by: String,
    at: { type: Date, default: Date.now },
  }),
);

// Plain-object types exactly as `.lean()` returns them (derived, so they can't drift from the schemas).
const _company = async () => (await Company.findOne().lean())!;
const _contact = async () => (await Contact.findOne().lean())!;
const _run = async () => (await Run.findOne().lean())!;
const _event = async () => (await Event.findOne().lean())!;
export type CompanyDoc = Awaited<ReturnType<typeof _company>>;
export type ContactDoc = Awaited<ReturnType<typeof _contact>>;
export type RunDoc = Awaited<ReturnType<typeof _run>>;
export type EventDoc = Awaited<ReturnType<typeof _event>>;
