# Requirements coverage

Every requirement in *ADIPEC Automated Lead Generation PTC v3.0*, mapped to where the backend implements it and what proves it.
"Person" means the step is done by a reviewer in the app, on purpose: the PTC forbids automating it (NFR-07) or it needs an access decision.

## The nine-stage process map (PTC §11, page 12)

| # | Stage | Backend | Proof |
|---|---|---|---|
| 01 | ADIPEC exhibitor directory: every accessible company, real counts | `pipeline/steps/directory.ts`, `sources/adipec.ts`. One JSON call returns the whole list (no pagination to miss). Listings with the same name merge into one company. Advertised (2,260) and discovered (1,969) are kept apart. | `pipeline.test.ts`, live run (`docs/adipec-source.md`) |
| 02 | Dedicated company page: profile fields + website | `pipeline/steps/profile.ts`: stand, hall, country, categories, description, website, socials, address, capture date. Missing fields are named in the reason. | `pipeline.test.ts`, `adipec.test.ts`, 15 live profiles |
| 03 | Official website and social profiles | `pipeline/steps/website.ts` + `sources/website.ts`: home + about / services / products / industries / locations / contact / news pages. Facts keep their page URL. Shared mailboxes only. Official socials (share links ignored). | `website.test.ts`, `plan-checklist.test.ts`, 4 live sites |
| 04 | Sales Navigator company search | **Person.** Each company gets a Sales Nav search link and lands in the `salesnav` review tab. The reviewer saves the account link + match confidence. Unclear website/name matches are flagged as possible duplicates. | `research.test.ts`, `api-phase23.test.ts` |
| 05 | Decision-maker identification (CXOs) | **Person.** The reviewer adds contacts (form or pasted CSV) and sets leadership coverage (Confirmed Partial / Unknown / Reviewed). One company → many contacts, never duplicated. | `api-phase23.test.ts`, `plan-checklist.test.ts` (100-row import) |
| 06 | Email enrichment | `pipeline/steps/emails.ts` + `providers/contactout.ts`: work emails only, with provider and capture date, never guessed, under a monthly cap. Without a key: "Pending Access" and reviewers type emails in. | `emails.test.ts` |
| 07 | AI research and hyper-personalization | `pipeline/steps/personalization.ts` + `providers/llm.ts` (Claude): summary, signal + URL, hypothesis, hyper-personalization, subject, email draft, LinkedIn draft, built only from numbered sourced facts. Checked for forbidden claims and made-up numbers. | `personalization.test.ts` |
| 08 | Initial consolidated CSV | `routes/exports.ts` `version=initial`: companies / contacts / outreach, every email "not_checked". | `phase456-api.test.ts`, `ptc-exports.test.ts` |
| 09 | Bulk verification and final CSV | `pipeline/steps/verification.ts`: MillionVerifier if available, else the free MX check (never "verified"). Then `version=final` with result, date and source. | `phase456-api.test.ts`, `plan-checklist.test.ts` |

## Functional requirements

| ID | Requirement (short) | Where | Status |
|---|---|---|---|
| FR-01 | Admin selects edition, starts a run | `POST /events`, `POST /runs` | ✅ |
| FR-02 | Discover every accessible directory entry | directory step | ✅ |
| FR-03 | Profile fields, original URL, capture date | profile step | ✅ |
| FR-04 | Identify/normalise website; flag missing/ambiguous | profile step (domain), website step `needs_review`, duplicate flag on shared domains | ✅ |
| FR-05 | About, industries, services, products, locations, contact, news | website step | ✅ |
| FR-06 | LinkedIn, Facebook, Instagram, X, YouTube, others | profile + website steps | ✅ |
| FR-07 | Facts apart from inferences, with URLs | `website.facts[].kind` + `sourceUrl`; AI hypotheses kept separate | ✅ |
| FR-08 | Counts: discovered, attempted, completed, partial, restricted, failed, duplicate | `Run` counts, overview, gap report | ✅ |
| FR-09 | Keep every company regardless of fit | nothing is scored out or auto-deleted | ✅ |
| FR-10 | Duplicates across name variants, domains, editions; queue ambiguity | name normalisation + listing merge; `checkDuplicates` flags → review | ✅ |
| FR-11 | Refresh research, keep reviewer edits (SHOULD) | weekly `refresh-websites` cron + `lockedFields` | ✅ |
| FR-12 | Match the Sales Nav account by domain/name; handle multiple matches | Person: search link, account URL + confidence, `salesnav` review tab | ✅ (manual by design) |
| FR-13 | Relationship Explorer CXO research (CONDITIONAL) | Person, in Sales Navigator | ✅ (manual by design) |
| FR-14 | Store every obtainable decision-maker | contacts collection, one-to-many | ✅ |
| FR-15 | Name, role, company, profile, geography, last verified date | contact fields + per-email `checkedAt` | ✅ |
| FR-16 | Coverage: Confirmed Partial / Unknown / Reviewed | `leadershipCoverage` | ✅ |
| FR-17 | Enrich via ContactOut or similar (CONDITIONAL) | ContactOut adapter (off without key) | ✅ |
| FR-18 | Batch verification after the initial CSV | verification run + nightly cron | ✅ |
| FR-19 / FR-21 | Unavailable → Not Checked / Unknown, never Verified | MX check gives invalid/unknown only; statuses stay honest | ✅ |
| FR-20 | Free/permitted verifier (CONDITIONAL) | MillionVerifier adapter (off without key, monthly cap) | ✅ |
| FR-22 | Reviewer completes what automation can't | contacts API, CSV import, company edits, step overrides | ✅ |
| FR-23 | Research summary + service opportunities | AI company draft | ✅ |
| FR-24 | Company-level hyper-personalization even with no contacts | runs after the website step | ✅ |
| FR-25 | Subject + email draft per contact before the initial CSV | AI contact drafts (queued when a contact is added) | ✅ |
| FR-26 | LinkedIn draft when a profile exists | empty when there's no profile link | ✅ |
| FR-27 | Cite a sourced fact, else Insufficient Evidence | fact IDs; signal URL from our stored fact | ✅ |
| FR-28 | Facts vs hypotheses vs questions | hypothesis must read as a possibility; draft is question-led | ✅ |
| FR-29 | No claims of acquaintance, ADIPEC meeting, partnership, interest | banned-claims check + one retry, else not saved | ✅ |
| FR-30 | Review, edit, reject, regenerate; keep the approved version | `PATCH …/ai`, `POST …/regenerate` | ✅ |
| FR-31 | No AI within cost/access → Personalization Pending | `pending` with reason; nothing invented | ✅ |

## PTC §5.1 and §6 fields

| Required | Where |
|---|---|
| §5.1 research summary, observed signal (+URL), opportunity hypothesis, hyper-personalization, subject, draft, LinkedIn draft, evidence + review status | company/contact `ai`; companies + outreach CSV columns |
| §6.1 identity: company ID, normalised name, original name, edition, profile URL, capture date | `companies.csv` (Company ID, Normalized Name, Original Names, Editions, ADIPEC Profile URL, Directory Capture Date) |
| §6.1 exhibition, website, social, tracking (statuses, duplicate flag, completeness, last updated) | `companies.csv` |
| §6.2 people, emails, AI outputs, quality (evidence, AI status, review notes, approved timestamp) | `contacts.csv` + `outreach.csv` |
| §6.3 three exports; outreach = one row per company–contact pair; company-only rows kept; Hyper-Personalization / Subject Line / Email Draft columns; profile URL, website, socials, contact sources, evidence, verification result + date | `routes/exports.ts`; every row's width is checked against its header |
| §6.3 filters: year, category, country, contacts, verification, research completeness, approval | `edition`, `category`, `country`, `hasContacts`, `emailStatus`, `minCompleteness`, `approved` (same filters for list and CSV) |
| §6.3 unknown values blank or with a status, never invented | blanks + per-step status and reason |

## Statuses (PTC §4.2, §7.3)

- **Step statuses:** all nine (`not_started`, `in_progress`, `completed`, `partial`, `needs_review`, `pending_access`, `restricted`, `failed`, `approved`), each with a reason. They're tracked separately for profile, website, social, account, people, emails, verification and personalization.
- **Email statuses:** `verified`, `invalid`, `risky`, `unknown`, `not_checked`, each with a date and a source.

## Non-functional requirements

| ID | Requirement | How |
|---|---|---|
| NFR-01 | No new paid commitments | Every paid provider is off without a key and has a hard monthly cap. Hosting is free tier (`docs/cost-declaration.md`). |
| NFR-02 | Audit of sources, timestamps, errors, edits | Fact URLs, `pagesReviewed`, step reasons + dates, run errors, `history` collection, export log |
| NFR-03 | Partial stages continue | Every step ends with a status and the company moves on. Failures are retried, then recorded. |
| NFR-04 | No duplicates on re-runs | Upserts on unique keys, job IDs, contact match by link/name, imports fill blanks only |
| NFR-05 | Protect credentials and contact data; roles; deletion | httpOnly cookie, bcrypt, admin/reviewer roles, rate limits, deletes, export log (`docs/runbook.md` §6) |
| NFR-06 | New editions without losing old mappings | `editions[]` per company. The same company across years stays one record. |
| NFR-07 | No bypassing logins, anti-bot or terms | robots.txt respected, blocks recorded as `restricted`, no LinkedIn automation, no disguised bot |
| NFR-08 | Report of completed vs blocked | `GET /reports/gap` (+ CSV) |

## Screens the backend serves (PTC §7.1)

| Screen | Endpoints |
|---|---|
| Overview | `/stats/overview` |
| Company directory | `/companies` (filters, sort, paging) |
| Company detail | `/companies/:id`, `/companies/:id/history` |
| Runs and scheduling | `/runs`, start / pause / resume; cron via GitHub Actions |
| Review queue | `/review`, `/review/counts` (website, duplicate, salesnav, contacts, emails, ai) |
| Exports | `/exports/:kind.csv`, `/exports/:kind/count`, `/exports/log`, `/verification/run`, `/reports/gap` |

## Exclusions honoured (PTC §1.3)

No automatic message sending, no buying lists or credits, no unrestricted attendee data, no unauthorised logins, and no claim that a company has a confirmed software need.

## What only people can close

The ADIPEC permission decision, which paid keys exist, the Sales Navigator work itself, and the real sample run with a reviewer. See `docs/acceptance.md` and `docs/runbook.md`.
