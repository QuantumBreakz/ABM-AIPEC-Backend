# ADIPEC Lead Gen — Backend Plan

**Owner: Ali Ahmed** · Frontend lives in [ABM-AIPEC-Frontend](https://github.com/QuantumBreakz/ABM-AIPEC-Frontend) (Faseeh)

## The project in short

We pull every exhibitor from the ADIPEC site and read their website. A person finds the decision-makers in Sales Navigator, and the system finds emails where an approved tool exists. The AI writes research notes and drafts that a reviewer approves. We export a first CSV, check the emails in a batch, and export a final CSV.

Things the system must always do:

- **Never drop a company.** If a step fails, record why and move on.
- **Never make things up.** Every fact keeps its source link. Unknown means an explicit status, not an empty cell.
- **No new spending.** Paid tools are used only if we already have them. Without one, the step says "Pending Access" or "Not Checked".
- **No automation on LinkedIn or Sales Navigator.** A person does that part in our app.
- **No automatic email sending.** We produce drafts only.

Codes like FR-05, NFR-07, AT-03 or Gate 2 point to the PTC v3.0 requirements doc.

## Who owns what

| | Ali — Backend | Faseeh — Frontend |
|---|---|---|
| Repo | `ABM-AIPEC-Backend` | `ABM-AIPEC-Frontend` |
| Runs on | Render (free web service) + Render Key Value + MongoDB Atlas M0 | Vercel (Hobby) |
| Builds | API, data, scraping, queues, AI, email checks, CSV exports, cron | Every screen, mock backend, user flows, exports page |
| Depends on the other for | Nothing | Only the API contract (frozen in ticket J-0.1) |

### How we stay unblocked

- **The contract comes first** (J-0.1). After that, nobody waits on anybody.
- **Frontend runs on a mock backend** (MSW) built from the contract. Every screen can be built, demoed and tested with no backend running. Vercel preview deploys use the mocks.
- **Backend runs on seed data** (`npm run seed`). Every endpoint can be built and tested before the scrapers exist.
- **Integration checks** (J-1 … J-6) happen when both sides of a phase are done. They catch mismatches but never block starting the next phase.
- Contract changes follow the change rules in the contract section.

## Phases

Each phase ends at a release gate from the PTC. Within a phase, the two sides work in parallel.

| Phase | Goal | Gate | Acceptance tests |
|---|---|---|---|
| 0 Foundations | Repos, hosting, contract, auth, mocks/seed | – | – |
| 1 Exhibitors | Every exhibitor listed and its profile captured | Gate 1 Source proof | AT-01, AT-02 |
| 2 Company research | Website facts, socials, duplicates, review queue | Gate 2 Research proof | AT-03, AT-10 |
| 3 People | Sales Nav review flow, contacts, email lookup | Gate 3 People proof | AT-04, AT-05, AT-06, AT-09 |
| 4 AI + first CSV | Sourced drafts, review/approve, exports | Gate 5 Personalization proof | AT-08, AT-11 (initial) |
| 5 Email check + final CSV | Batch verification, final export | Gate 4 Verification proof | AT-07, AT-11 (final) |
| 6 Hardening & delivery | Gap report, security, backups, acceptance run, docs | Gate 6 Delivery proof | AT-12 + full AT-01…12 run |

## Hosting (all free) and how we live with the limits

| Piece | Where | Limit that matters | What we do about it |
|---|---|---|---|
| API **+ workers** | Render, one free web service | No free background workers. Sleeps after 15 min with no traffic and takes ~1 min to wake. 512 MB RAM, 0.1 CPU. 750 instance hours/month per workspace. | API and BullMQ workers run in **one process**. GitHub Actions pings `/health` every 10 min. One always-on service uses ~744 hrs/month, so this is our **only** free Render service. |
| Queue | Render Key Value (free) | One per workspace. Memory only. **Wiped on restart.** | Mongo is the source of truth. Queueing a step marks it `in_progress` in Mongo, and on boot we put back everything still `in_progress`. Set `maxmemoryPolicy: noeviction` (BullMQ breaks otherwise). Jobs carry only IDs; finished jobs are removed. |
| Database | MongoDB Atlas M0 | 512 MB. No backups. Render free has no fixed IP. | Store facts and links, never raw HTML (2,250 companies ≈ well under 100 MB). Network access 0.0.0.0/0 with a long random DB password. Weekly encrypted backup via Actions (BE-6.3). |
| Cron | GitHub Actions (free on public repos) | Schedules can lag 5–15 min. Only runs on the default branch. Paused after 60 days with no commits. | Actions calls `POST /cron/:task` with a secret header; the backend queues the work. Nothing depends on exact timing. |
| Heavy browser work (only if needed) | GitHub Actions job | 7 GB RAM, 6 hrs per job | If the ADIPEC list needs a real browser, a Playwright script runs there and writes straight to Mongo. Render's 512 MB can't run Chrome reliably. |
| AI | Approved key, or free tier (Gemini / Groq) | Rate limits; free tiers may train on inputs | BullMQ rate limiter set from env. Jobs back off on 429. No key = `pending` with reason. |
| Email checks | Built-in MX lookup + MillionVerifier if credits exist | MX can't prove an inbox exists | MX only ever gives `invalid` or `unknown`. `verified` only comes from MillionVerifier. |

## Stack

| Need | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript, ESM | Render default, long support |
| HTTP | Express 5 | Async errors handled for free; everyone knows it |
| DB | Mongoose 9 | Schemas + indexes on a flexible store |
| Queue | BullMQ + ioredis | Retries, backoff, rate limits, pause/resume |
| Validation | zod | One schema for env, request bodies and LLM output |
| Scraping | undici `fetch` + cheerio, `robots-parser`, `tldts` | Light enough for 512 MB |
| Auth | bcrypt + JWT in an httpOnly cookie, `express-rate-limit` | Simple, no session store |
| CSV | `csv-stringify` (streaming), `csv-parse` (imports) | Handles big exports without loading everything |
| Logs | pino + pino-http | JSON logs that Render shows; request IDs |
| Security headers | helmet | Standard |
| Tests | Vitest, supertest, mongodb-memory-server | Real Mongo in tests, no mocks of the DB |
| Lint/format | Biome | One tool, fast |

## Folder layout

```
src/
  index.ts            boot: env → mongo → redis → workers → requeue → http
  app.ts              express app (exported for tests, no listen)
  env.ts              zod-checked env
  db/                 one file per model + indexes; helpers setStep(), saveWithHistory()
  lib/                fetcher (polite + SSRF-safe), normalize, csv, errors, logger, auth
  routes/             auth, users, events, stats, runs, companies, contacts, review, ai, exports, verification, reports, settings, suppressions, cron
  pipeline/
    queue.ts          queues, enqueue(), workers, requeue on boot
    steps/            directory, profile, website, dedupe, emails, personalization, verification
  providers/          contactout, millionverifier, llm, mx
scripts/              seed.ts, create-admin.ts, directory-playwright.ts (only if needed)
test/                 unit + API tests, fixtures/ (saved public HTML, fake data only)
docs/                 adipec-source.md, runbook.md, acceptance.md, cost-declaration.md
.github/workflows/    ci.yml, keepalive.yml, cron.yml, backup.yml, directory.yml (if needed)
render.yaml
```

## Environment variables

| Name | Example / note |
|---|---|
| `PORT` | Render sets it |
| `NODE_ENV` | `production` on Render |
| `MONGO_URL` | Atlas connection string |
| `REDIS_URL` | from Render Key Value (internal URL) |
| `JWT_SECRET` | 64+ random chars |
| `CRON_SECRET` | 32+ random chars; same value in GitHub Secrets |
| `SCRAPER_USER_AGENT` | `SmartLogicsResearchBot/1.0 (+contact email)` |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_RPM` | empty key = AI off |
| `CONTACTOUT_API_KEY` / `CONTACTOUT_MAX_LOOKUPS` | empty = off; max is a hard per-run cap |
| `MILLIONVERIFIER_API_KEY` / `MILLIONVERIFIER_MAX_CHECKS` | empty = off |
| `LOG_LEVEL` | `info` |

A provider is "on" only when its key is set. `GET /settings/providers` reports exactly that.

## The pipeline

One BullMQ queue per step. A job holds only `{ companyId }` or `{ contactId }` plus `runId`. Job ID = `step-id`, so queueing the same thing twice does nothing.

```
directory ─► profile ─► website (+ socials) ─► dedupe ─► [Sales Nav: person] ─► emails ─► personalization
                                                    └──────────────► company-level personalization (even with no contacts)
first CSV (person clicks export) ─► verification (batch) ─► final CSV
```

| Step | Trigger | Success | When it can't finish |
|---|---|---|---|
| directory | `POST /runs` | companies upserted, `counts.discovered` set | page errors logged on the run; partial count kept |
| profile | after directory, per company | `profile=completed` | `partial` (some fields missing) / `failed` (page error) / `restricted` (blocked) |
| website | after profile | `website=completed`, `social=completed\|partial` | no URL → `needs_review`; dead/parked → `failed`; robots-blocked → `restricted` |
| dedupe | after website | nothing to do | likely duplicate → `needs_review` (review type `duplicate`) |
| account / people | set right after dedupe | person completes it in the app | always starts as `pending_access`, reason "Waiting for Sales Navigator review" |
| emails | when a contact is added | emails stored with provider + date | no ContactOut → `pending_access`; budget hit → `pending_access` |
| personalization | company: after website. contact: after the contact is added | `draft` | no key → `pending`; no sourced fact → `insufficient_evidence` |
| verification | `POST /verification/run` or cron | each email gets a status + date + source | no checker → stays `not_checked` |

**Every step ends by calling `setStep(companyId, step, status, reason)`, success or not, then queues the next step.** Throwing is only for retryable errors (network, 429). After the last retry the job's failed handler records `failed` + reason, so nothing stays stuck.

**Human edits win.** Any PATCH from a person goes through `saveWithHistory()`. That records the old value and adds the field to `company.lockedFields`, and workers never overwrite locked fields.

## Scraping rules (fetcher in `lib/fetcher.ts`, used everywhere)

- Send our own `User-Agent`. Check `robots.txt` per domain and cache it. If it disallows us, mark `restricted`.
- One request at a time per domain, with 1.5 s between requests. 15 s timeout. 2 MB max body. HTML only.
- At most 3 retries with backoff, and only on network errors, 429 or 5xx.
- **SSRF guard:** exhibitor websites are untrusted input. Only allow `http(s)`. Resolve DNS and refuse private, loopback and link-local IPs, so a malicious URL can't reach our Redis or Render's internal network. Re-check after every redirect.
- Never log in, never solve captchas, never get around a block. Blocked means `restricted`.
- No search-engine scraping to "find" a missing website. That goes to the review queue instead.
- Never guess email patterns like `first.last@domain`.

## CSV export spec

UTF-8 with BOM (so Excel opens it cleanly), comma-separated, header row, one file per request.
**Formula-injection guard:** any cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`.
Suppressed emails and domains are always left out.
AI columns use the **approved** version if there is one. Otherwise they use the latest draft, and the `ai_status` column says it's a draft.

**companies.csv:** company_id, company_name, edition, adipec_profile_url, captured_at, stand, category, country, exhibitor_description, website, domain, company_summary, services, markets, linkedin_company, facebook, instagram, x, youtube, other_socials, leadership_coverage, contacts_count, duplicate_of, completeness, status_profile, status_website, status_social, status_account, status_people, status_emails, status_verification, status_personalization, last_updated

**contacts.csv:** contact_id, company_id, company_name, first_name, last_name, title, seniority, profile_url, geography, match_confidence, contact_source, email, email_type, email_provider, email_captured_at, email_verification_status, email_checked_at, email_check_source

**outreach.csv** (one row per company–contact pair; companies with no contact still get one row with `contact_status=no_contact_found`): company_id, company_name, edition, adipec_profile_url, website, linkedin_company, other_socials, company_summary, observed_signal, signal_url, opportunity_hypothesis, **Hyper-Personalization**, contact_id, contact_status, first_name, last_name, title, contact_profile_url, contact_source, email, email_source, email_verification_status, email_checked_at, **Subject Line**, **Email Draft**, LinkedIn Draft, evidence_urls, ai_status, approved_at, last_updated

`version=initial` and `version=final` have the same columns. The version is written to the export log and the filename (`outreach-2026-initial-<date>.csv`) so we can prove the order: initial, then verification, then final.

## Running locally

```bash
brew services start mongodb-community && brew services start redis   # or docker compose up
cp .env.example .env
npm i
npm run seed            # fake data in every state
npm run create-admin    # prompts for email + password
npm run dev             # API + workers on :4000
npm test
```

---

## Backend tickets

Each ticket lists what it **needs** first. Those are only backend tickets or J-0.1, never frontend work.

### Phase 0 — Foundations

**BE-0.1 Project setup**
TS + ESM, Biome, Vitest, the folder layout above, `env.ts` (zod; refuse to boot on bad env), pino logger with request IDs and redacted cookie/auth headers, a central error handler that returns the contract error shape, and the `app.ts` / `index.ts` split.
- [ ] `npm run dev`, `build`, `test`, `lint` all work
- [ ] Unknown route returns `404 { error: { code: 'not_found' } }`
- [ ] A thrown error returns `500 internal` with no stack trace in production

**BE-0.2 Hosting**
Atlas M0 cluster + DB user. `render.yaml` with the web service (free, `healthCheckPath: /health`) and Key Value (free, `noeviction`, internal only). Env vars set on Render.
Needs: BE-0.1
- [ ] Render deploy is live and `/health` returns `{ ok: true, mongo: true, redis: true }`
- [ ] `.env.example` lists every variable

**BE-0.3 GitHub Actions + repo rules**
`ci.yml` (lint, typecheck, test, build, `npm audit --audit-level=high`). `keepalive.yml` (every 10 min, skipped if repo variable `BACKEND_URL` is empty). `cron.yml` (manual trigger now; schedules added in BE-2.6 / BE-5.3). Branch protection on `main`. A gitleaks secret scan on PRs.
Needs: BE-0.1
- [ ] CI is required for merging
- [ ] Keepalive keeps Render awake (no cold start for an hour in Render logs)

**BE-0.4 Data models**
All collections from the contract types: events, companies, contacts, runs, history, users, suppressions, exportLogs. Indexes: `companies.normalizedName` unique; `companies.domain` unique when set; `companies.editions.edition`; `contacts (companyId, profileUrl)` unique when set; `history (entityId, at)`. Helpers: `setStep()`, `saveWithHistory()` (writes history + `lockedFields`), and `toListItem()` / `toCompany()` mappers that produce exactly the contract shapes.
Needs: BE-0.1
- [ ] Tests: `saveWithHistory` records only changed fields and locks them
- [ ] Mappers output matches the contract types (typed test)

**BE-0.5 Queue plumbing**
Queues per step. `enqueue()` marks the step `in_progress` (reason "queued"). Workers start in-process with concurrency 2. Worker failed-handler records `failed` + reason after the last attempt. On boot: put back every `in_progress` step and re-pause runs that are `paused` in Mongo. Graceful SIGTERM (finish current jobs, close connections). `/health` reports redis + worker count.
Needs: BE-0.4
- [ ] Flush Redis while jobs are queued, restart: every job comes back
- [ ] Same job queued twice runs once

**BE-0.6 Auth and users**
Login (bcrypt, JWT in an `sid` cookie: httpOnly, Secure, SameSite=Lax, 7 days), logout, `me`, a `requireRole()` middleware, login rate limit (10 tries per 15 min per IP+email), users CRUD (admin), and the `npm run create-admin` script. `app.set('trust proxy', 1)` for Render and Vercel.
Needs: BE-0.4
- [ ] API tests: wrong password → 401; reviewer on an admin route → 403; 11th login try → 429
- [ ] Password hashes never appear in any response

**BE-0.7 Seed data**
`npm run seed` creates one event and ~150 **fake** companies spread across every step status, with contacts, emails in every verification status, AI in every status, a few duplicates, and a finished and a paused run. `npm run seed:reset` wipes it. Names like "Example Drilling LLC", domains under `example.com`.
Needs: BE-0.4
- [ ] Every enum value appears at least once in the seed

**J-0.1 Freeze the API contract** (joint, see below)

### Phase 1 — Exhibitors (Gate 1)

**BE-1.1 ADIPEC source spike**
Work out how `adipec.com/exhibition/exhibitor-list` loads: plain HTML, a JSON call, or JS-only. Note pagination, total count, profile URL pattern and which fields a profile shows. Check `robots.txt` and the site terms. Write it all in `docs/adipec-source.md` with the decision: fetch on Render, or Playwright in Actions.
- [ ] Doc answers: how to list all, how many we see vs the 2,250+ advertised, what a profile has, whether we're allowed
- [ ] 2–3 saved public responses go in `test/fixtures/adipec/`

**BE-1.2 Polite fetcher**
`lib/fetcher.ts` following the scraping rules above, including the SSRF guard and robots cache.
Needs: BE-0.1
- [ ] Tests: blocks `http://127.0.0.1`, `http://10.x`, `http://169.254.169.254` and redirects into them; respects robots disallow; caps body size; spaces out requests to the same domain

**BE-1.3 Normalization helpers**
`normalizeName()`: lowercase; strip legal suffixes (LLC, L.L.C, FZE, FZCO, FZ-LLC, Ltd, Limited, Inc, Corp, Co, PJSC, PLC, GmbH, AG, SA, SpA, BV, WLL); `&` → `and`; drop punctuation; collapse spaces. `normalizeDomain()`: lowercase, drop `www.`, registrable domain via `tldts`. `nameSimilarity()` (token-based).
- [ ] Table-driven tests with at least 30 real-world-style cases

**BE-1.4 Events + Runs API**
`/events`, `/runs` (start, list, get, pause = pause all queues + `status=paused`, resume). Run counts and `perStep` built from Mongo, so they survive Redis wipes.
Needs: BE-0.5, BE-0.6
- [ ] Starting a run while one is running → 409
- [ ] Pause stops new jobs within seconds; resume continues

**BE-1.5 Directory step**
Lists every exhibitor (all pages). Upserts the company by `normalizedName` and adds or updates the edition entry with `profileUrl` and `capturedAt`. Sets `counts.discovered` and saves `advertisedCount` on the event. Queues `profile` per company. Each page that fails goes into `run.errors`, and the step carries on. If BE-1.1 says a browser is needed: `scripts/directory-playwright.ts` + `directory.yml` (manual trigger) does the same writes from Actions.
Needs: BE-1.1, BE-1.2, BE-1.3, BE-1.4
- [ ] Running twice creates no duplicates (AT-10)
- [ ] Discovered count matches the site; any difference is explained in `run.errors` (AT-01)

**BE-1.6 Profile step**
Opens each profile and saves stand, category, country, description, website URL and any other published fields (into `extra`), plus `capturedAt`. Status `completed`, or `partial` with a reason listing what was missing.
Needs: BE-1.5
- [ ] Parser tests on saved fixtures
- [ ] A company with no website still completes the profile step and moves on (AT-02)

**BE-1.7 Companies read API + overview**
`GET /companies` (every filter, sort and pagination in the contract), `GET /companies/:id`, `GET /stats/overview` (aggregations).
Needs: BE-0.4, BE-0.7
- [ ] API tests for each filter against seed data
- [ ] List of 50 on seed data responds in under 300 ms locally

### Phase 2 — Company research (Gate 2)

**BE-2.1 Website step**
Resolves the official URL (follow redirects, store the final domain). Crawls up to 8 same-domain pages: home, plus links matching about / company / who-we-are / products / services / solutions / industries / markets / contact / news / media. Pulls out:
- summary (meta description or first meaningful paragraphs)
- services and markets (headings and list items on those pages)
- generic contact details (info@-style emails, phones, addresses) with the source page
- facts: short sentences with `sourceUrl`, `kind: 'fact'`

Records `pagesReviewed` and `skipped` (with reasons). Never stores raw HTML. Skips any `lockedFields`.
Needs: BE-1.2, BE-1.6
- [ ] Extraction tests on 3+ saved fixture sites
- [ ] No-URL / dead / parked / robots-blocked cases each get the right status and reason (AT-03)

**BE-2.2 Social links**
Inside the website job: collect links to `linkedin.com/company`, facebook, instagram, `x.com` / `twitter.com`, youtube. Ignore share/intent links. Status `completed`, or `partial` with reason "No social links visible on site".
Needs: BE-2.1
- [ ] Tests for share-link filtering and multiple matches

**BE-2.3 Dedupe step + merge**
Same domain → merge automatically (keep the older record; move editions, contacts and facts; write history). Names similar above a threshold but different or missing domains → `needs_review`. `POST /companies/:id/merge` and `/not-duplicate` (stores a "not duplicate of X" note so it isn't asked again).
Needs: BE-1.3, BE-2.1
- [ ] Merge keeps every edition and contact; history shows the merge
- [ ] Re-running dedupe after "not duplicate" doesn't re-flag the pair (AT-10)

**BE-2.4 Company write API**
`PATCH /companies/:id` (allowed fields only, through `saveWithHistory`), `POST /companies/:id/steps/:step`, `GET /companies/:id/history`, `DELETE /companies/:id` (admin; deletes contacts; history keeps a deletion entry without the personal data).
Needs: BE-0.4, BE-0.6
- [ ] Editing a field locks it; the next website refresh leaves it alone

**BE-2.5 Review queue API**
`GET /review` and `/review/counts`, built from data, not stored separately:
- `website`: website `needs_review`
- `duplicate`: dedupe flagged
- `salesnav`: account or people `pending_access` / `needs_review`
- `contacts`: people completed but 0 contacts
- `emails`: emails `invalid` / `risky`, or `pending_access`
- `ai`: `insufficient_evidence` or `rejected`

Needs: BE-1.7
- [ ] Counts match the list totals on seed data

**BE-2.6 Website refresh (cron)**
Cron task `refresh-websites` re-queues the website step for companies last checked more than 30 days ago. Locked fields are kept. Turn on the weekly schedule in `cron.yml`.
Needs: BE-2.1, BE-0.3
- [ ] Manual workflow run triggers it; reviewer edits survive (FR-11)

### Phase 3 — People (Gate 3)

**BE-3.1 Sales Navigator hand-off**
After dedupe, set `account` and `people` to `pending_access` with reason "Waiting for Sales Navigator review". Return `salesNav.searchUrl` (a plain Sales Nav search link with the company name). It's just a link: the system never opens or reads LinkedIn.
Needs: BE-2.3
- [ ] Every researched company shows up in review type `salesnav`

**BE-3.2 Contacts API + CSV paste import**
Create, update and delete contacts. Duplicate check by `profileUrl`, or by first+last name within the company. Email syntax check. `source` is required. Import parses pasted CSV with the columns in the contract and returns per-row errors (never all-or-nothing). Adding a contact queues `emails` and contact-level `personalization`. `leadershipCoverage` is set via company PATCH. Contacts on suppressed emails/domains are flagged.
Needs: BE-2.4
- [ ] Import of 100 rows with 5 bad ones creates 95 and reports 5 (AT-05)
- [ ] Re-importing the same file creates nothing new (AT-10)

**BE-3.3 Email lookup (ContactOut adapter)**
Only if `CONTACTOUT_API_KEY` is set. Looks up by profile URL and saves each email with provider, source and capture date. Stops at `CONTACTOUT_MAX_LOOKUPS` per run, and anything left over becomes `pending_access` ("Lookup budget reached"). No key → `pending_access` ("ContactOut not connected"); reviewers can type emails in manually.
Needs: BE-3.2
- [ ] With no key, the whole run still finishes (AT-09)
- [ ] Every stored email has a provider and date (AT-06)

**BE-3.4 Suppressions**
CRUD (admin). One `isSuppressed(emailOrDomain)` helper used by exports, AI and email lookup.
Needs: BE-0.4
- [ ] A suppressed email never appears in any export

### Phase 4 — AI + first CSV (Gate 5)

**BE-4.1 LLM adapter**
`providers/llm.ts`: one function `generateJson(prompt, schema)`. Provider and model come from env. BullMQ limiter set from `LLM_RPM`. A 429 delays the job instead of failing it. No key → status `pending` with reason "No approved AI service".
- [ ] Swapping provider needs only env changes

**BE-4.2 Context pack**
Builds the input from stored data only: company name, ADIPEC description, website facts (each with URL), services, markets, the contact's name, title and seniority. Hard size cap. Suppressed contacts are excluded.
Needs: BE-2.1, BE-3.2
- [ ] Snapshot test: nothing in the pack lacks a source

**BE-4.3 Personalization step**
Company level (runs even with zero contacts — FR-24): summary (2–5 sentences), signal + signalUrl, hypothesis (worded as a possibility), hyper-personalization (1–3 sentences), evidenceUrls. Contact level: subject, email draft (question-led), LinkedIn draft only if a profile URL exists.
Checks before saving:
- the output matches the zod schema
- every URL is in the pack
- there is a signal with a URL, otherwise `insufficient_evidence`
- banned claims are rejected and retried once: met at ADIPEC, existing partnership, "as discussed", made-up numbers

Saved as a new version. The approved version is never touched.
Needs: BE-4.1, BE-4.2
- [ ] Validator tests with good and bad outputs (AT-08)

**BE-4.4 AI review API**
`PATCH …/ai` with `save` (new version, `by` = user), `approve` (copies the current fields into `approved`, sets `approvedAt`, status `approved`), `reject` (reason required). `POST …/regenerate` queues a new draft and keeps `approved`.
Needs: BE-4.3
- [ ] Approve → regenerate → the approved copy is unchanged (FR-30)

**BE-4.5 Exports**
`/exports/:kind/count`, `/exports/:kind.csv` and `/exports/log`, following the CSV spec. Streams the output, so memory stays flat on big exports. Every download is logged with who, when, filters and row count. If the Vercel proxy ever times out on large files, add a short-lived signed link straight to Render.
Needs: BE-1.7, BE-3.4
- [ ] Tests: formula-injection escaping, company-only rows, suppression filtering, BOM present
- [ ] Initial export has Hyper-Personalization, Subject Line and Email Draft columns, with emails `not_checked` (AT-11)

### Phase 5 — Email check + final CSV (Gate 4)

**BE-5.1 MX checker**
Syntax check, then `dns.resolveMx` (cached per domain). Bad syntax or no MX → `invalid`. MX found → `unknown`, source "mx-only". Never `verified`.
- [ ] Tests with a stubbed resolver

**BE-5.2 MillionVerifier adapter**
Only if the key is set. Bulk upload, poll, download results. Map their result codes to ours (`ok` → verified, `invalid` → invalid, `catch_all` / `disposable` → risky, `unknown` / `error` → unknown), with the mapping documented in code. Stops at `MILLIONVERIFIER_MAX_CHECKS`.
Needs: BE-5.1
- [ ] Mapping tests; budget stop leaves the rest `not_checked` (FR-19)

**BE-5.3 Verification batch**
`POST /verification/run` + cron task `verify-emails`. Checks every email that is `not_checked` (or older than 30 days), using MillionVerifier if on, otherwise MX. Writes status, date and source per email and updates each company's `verification` step. Turn on the nightly schedule in `cron.yml`.
Needs: BE-5.1, BE-5.2, BE-0.3
- [ ] After an initial export, a batch gives every email a status with a date and source (AT-07)

**BE-5.4 Final export**
Same endpoint with `version=final`. Check that the log shows the order initial → verification → final.
Needs: BE-4.5, BE-5.3
- [ ] Final CSV includes verification status and date (AT-11)

### Phase 6 — Hardening & delivery (Gate 6)

**BE-6.1 Gap report**
`GET /reports/gap` + `.csv`: advertised vs discovered, researched, contacts found, emails checked, AI done, per-step status counts, and every blocked record with its reason (NFR-08).
- [ ] Totals add up to the discovered count

**BE-6.2 Security pass**
helmet, rate limits on auth and exports, zod on every body and query, cookie flags checked, `npm audit` clean at high, admin-only routes re-checked, no personal data in logs.
- [ ] Short checklist in `docs/runbook.md` ticked

**BE-6.3 Backups**
`backup.yml` runs weekly: `mongodump`, encrypt with `age` using a public key in secrets, upload as a workflow artifact (90 days). The repo is public, so it must be encrypted. Restore tested once into a local Mongo.
- [ ] Restore steps written and tried

**BE-6.4 Data rights**
Deleting a company or contact removes the personal data everywhere. Suppression is enforced in all outputs. The export log shows who downloaded what (NFR-05, §8.2).
- [ ] Deleting a contact then exporting shows it gone

**BE-6.5 Acceptance run**
Run AT-01 … AT-12 on a real sample (say 50 exhibitors). Write results in `docs/acceptance.md`. Write `docs/cost-declaration.md` listing every external service, what it costs and whether it's on (AT-12).
- [ ] All 12 recorded as pass, or explained

**BE-6.6 Runbook**
`docs/runbook.md`: deploy, env vars, rotating secrets, what to do when Render sleeps, Redis gets wiped, Atlas fills up, or a provider key runs out.
- [ ] The other person can redeploy from scratch using only this doc

---

## API contract

> **This section is identical in both repos.** It is the only thing either side depends on. Change it in both PLAN.md files in the same day, and follow the change rules below.

### Ground rules

- The browser calls `/api/...`. Vercel forwards that to Render and strips `/api`. Backend routes have **no** `/api` prefix.
- JSON everywhere except CSV downloads. Dates are ISO 8601 strings. IDs are strings.
- **Auth:** login sets an httpOnly cookie called `sid`. Every route needs it except `POST /auth/login`, `GET /health` and `POST /cron/*`.
- **Lists:** `?page=1&pageSize=50` returns `{ items, page, pageSize, total }`. Max `pageSize` is 200.
- **Errors:** always `{ "error": { "code": "...", "message": "...", "details": {...}? } }`.
  Codes: `bad_request` 400 · `unauthorized` 401 · `forbidden` 403 · `not_found` 404 · `conflict` 409 · `rate_limited` 429 · `internal` 500.
- **Slow actions** (start run, regenerate AI, verify emails) return `202 { "queued": true }`. The client then polls the related resource.
- **Missing data is explicit:** a field we couldn't get is left out, and the step status tells you why. Never use `""` or `"N/A"` to fill a gap.

### Change rules (so nobody gets blocked)

1. **Adding** a field or endpoint: backend just ships it and updates this section. Frontend picks it up whenever.
2. **Renaming or removing** something: don't. Add the new one and keep the old one until frontend has switched. Then remove it in a separate PR that both of you approve.
3. Whoever changes this section updates it in **both** repos.

### Types

```ts
// ---------- enums ----------
type StepKey = 'profile' | 'website' | 'social' | 'account' | 'people' | 'emails' | 'verification' | 'personalization';
type StepStatus = 'not_started' | 'in_progress' | 'completed' | 'partial' | 'needs_review'
                | 'pending_access' | 'restricted' | 'failed' | 'approved';
type EmailStatus = 'verified' | 'invalid' | 'risky' | 'unknown' | 'not_checked';
type AiStatus = 'pending' | 'insufficient_evidence' | 'draft' | 'approved' | 'rejected';
type Coverage = 'confirmed_partial' | 'unknown' | 'reviewed';
type Confidence = 'high' | 'medium' | 'low';
type Role = 'admin' | 'reviewer';
type ReviewType = 'website' | 'duplicate' | 'salesnav' | 'contacts' | 'emails' | 'ai';
type ExportKind = 'companies' | 'contacts' | 'outreach';

// ---------- shared ----------
type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };
type StepState = { status: StepStatus; reason?: string; updatedAt?: string };
type Fact = { text: string; sourceUrl: string; kind: 'fact' | 'inference' };

// ---------- users ----------
type User = { id: string; email: string; role: Role; createdAt: string };

// ---------- events ----------
type Event = { id: string; edition: number; name: string; directoryUrl: string; advertisedCount?: number };

// ---------- companies ----------
type Edition = {
  edition: number; profileUrl: string; stand?: string; category?: string; country?: string;
  description?: string; extra?: Record<string, string>; capturedAt: string;
};

type CompanyListItem = {
  id: string; name: string; domain?: string; country?: string; category?: string; stand?: string;
  editions: number[];
  stages: Record<StepKey, StepState>;
  contactsCount: number;
  emailsByStatus: Partial<Record<EmailStatus, number>>;
  aiStatus: AiStatus;
  duplicateOf?: string;
  completeness: number;            // 0–100
  updatedAt: string;
};

type Company = Omit<CompanyListItem, 'editions'> & {
  originalNames: string[];
  editions: Edition[];
  website: {
    url?: string; summary?: string; services: string[]; markets: string[];
    contactDetails: { emails: string[]; phones: string[]; addresses: string[]; sourceUrl?: string };
    pagesReviewed: { url: string; fetchedAt: string }[];
    skipped: { url: string; reason: string }[];
    facts: Fact[];
  };
  socials: { linkedin?: string; facebook?: string; instagram?: string; x?: string; youtube?: string; other: string[] };
  salesNav: { accountUrl?: string; matchConfidence?: Confidence; searchUrl: string };
  leadershipCoverage: Coverage;
  lockedFields: string[];          // fields a human edited; workers won't overwrite them
  ai: CompanyAi;
  contacts: Contact[];
};

type CompanyFilters = {
  q?: string; edition?: number; category?: string; country?: string;
  step?: StepKey; stepStatus?: StepStatus;
  hasContacts?: boolean; emailStatus?: EmailStatus; aiStatus?: AiStatus; duplicate?: boolean;
  sort?: 'name' | '-name' | 'updatedAt' | '-updatedAt' | 'completeness' | '-completeness';
};

// ---------- contacts ----------
type Email = {
  address: string; type?: 'business' | 'generic'; provider?: string; capturedAt: string;
  verification: { status: EmailStatus; checkedAt?: string; source?: string };
};

type Contact = {
  id: string; companyId: string; firstName: string; lastName: string;
  title?: string; seniority?: string; profileUrl?: string; geography?: string;
  matchConfidence?: Confidence; source: string;  // 'manual' | 'csv_import' | 'contactout' | ...
  emails: Email[]; ai: ContactAi; createdAt: string; updatedAt: string;
};

type ContactInput = {
  firstName: string; lastName: string; title?: string; seniority?: string; profileUrl?: string;
  geography?: string; matchConfidence?: Confidence; source: string;
  emails?: { address: string; type?: 'business' | 'generic'; provider?: string }[];
};

// ---------- AI ----------
type AiVersion = { fields: Record<string, string>; by: string; at: string };

type CompanyAi = {
  status: AiStatus; reason?: string;
  summary?: string; signal?: string; signalUrl?: string; hypothesis?: string;
  hyperPersonalization?: string; evidenceUrls: string[];
  approved?: AiVersion;            // last approved copy; exports prefer this
  versions: AiVersion[];           // newest first
};

type ContactAi = {
  status: AiStatus; reason?: string;
  subject?: string; draft?: string; linkedinDraft?: string; evidenceUrls: string[];
  approved?: AiVersion; versions: AiVersion[];
};

// ---------- runs ----------
type Run = {
  id: string; edition: number; status: 'running' | 'paused' | 'completed' | 'failed';
  steps: (StepKey | 'directory')[]; startedBy: string; createdAt: string; finishedAt?: string;
  counts: { discovered: number; attempted: number; completed: number; partial: number;
            restricted: number; failed: number; duplicate: number };
  perStep: Record<string, { queued: number; done: number; failed: number }>;
  errors: { companyId?: string; companyName?: string; step: string; message: string; at: string }[]; // last 100
};

// ---------- review / reports ----------
type ReviewItem = { type: ReviewType; companyId: string; companyName: string;
                    contactId?: string; contactName?: string; reason: string; since: string };

type Overview = {
  edition: number; advertised?: number; discovered: number; unique: number; duplicates: number;
  byStep: Record<StepKey, Partial<Record<StepStatus, number>>>;
  contacts: number; companiesWithContacts: number;
  emailsByStatus: Record<EmailStatus, number>; ai: Record<AiStatus, number>; failures: number;
};

type GapReport = {
  edition: number; generatedAt: string; advertised?: number; discovered: number; researched: number;
  contactsFound: number; emailsChecked: number; aiDone: number;
  byStep: Record<StepKey, Partial<Record<StepStatus, number>>>;
  blocked: { companyId: string; companyName: string; step: StepKey; status: StepStatus; reason?: string }[];
};

type HistoryEntry = { field: string; before: unknown; after: unknown; by: string; at: string };
type ExportLogEntry = { id: string; kind: ExportKind; version: 'initial' | 'final';
                        filters: CompanyFilters; rows: number; by: string; at: string };
type Providers = { contactout: boolean; millionverifier: boolean; llm: boolean; llmModel?: string };
type Suppression = { id: string; value: string; reason?: string; at: string };
```

### Endpoints

`user` = any logged-in user. `admin` = admin only.

| Method | Path | Who | Send | Get back |
|---|---|---|---|---|
| **Auth** |||||
| POST | `/auth/login` | anyone | `{ email, password }` | `User` + sets cookie |
| POST | `/auth/logout` | user | – | 204 |
| GET | `/auth/me` | user | – | `User` |
| **Users** |||||
| GET | `/users` | admin | – | `User[]` |
| POST | `/users` | admin | `{ email, password, role }` | `User` |
| PATCH | `/users/:id` | admin | `{ role?, password? }` | `User` |
| DELETE | `/users/:id` | admin | – | 204 |
| **Events & overview** |||||
| GET | `/events` | user | – | `Event[]` |
| POST | `/events` | admin | `{ edition, name, directoryUrl, advertisedCount? }` | `Event` |
| GET | `/stats/overview` | user | `?edition` | `Overview` |
| **Runs** |||||
| GET | `/runs` | user | `?page` | `Paged<Run>` |
| POST | `/runs` | admin | `{ edition, steps? }` (no steps = everything) | 202 `Run` |
| GET | `/runs/:id` | user | – | `Run` |
| POST | `/runs/:id/pause` | admin | – | `Run` |
| POST | `/runs/:id/resume` | admin | – | `Run` |
| **Companies** |||||
| GET | `/companies` | user | `CompanyFilters` + `page`, `pageSize` | `Paged<CompanyListItem>` |
| GET | `/companies/:id` | user | – | `Company` |
| PATCH | `/companies/:id` | user | any of `website.url`, `website.summary`, `website.services`, `website.markets`, `socials.*`, `salesNav.accountUrl`, `salesNav.matchConfidence`, `leadershipCoverage` | `Company` |
| POST | `/companies/:id/steps/:step` | user | `{ status, reason }` | `Company` |
| POST | `/companies/:id/merge` | user | `{ intoId }` | `Company` (the one kept) |
| POST | `/companies/:id/not-duplicate` | user | – | `Company` |
| GET | `/companies/:id/history` | user | – | `HistoryEntry[]` |
| DELETE | `/companies/:id` | admin | – | 204 (also deletes its contacts) |
| **Contacts** |||||
| POST | `/companies/:id/contacts` | user | `ContactInput` | `Contact` |
| POST | `/companies/:id/contacts/import` | user | `{ csv }` (columns: first_name,last_name,title,seniority,profile_url,geography,email) | `{ created, updated, errors: { row, message }[] }` |
| PATCH | `/contacts/:id` | user | `Partial<ContactInput>` | `Contact` |
| DELETE | `/contacts/:id` | admin | – | 204 |
| **Review queue** |||||
| GET | `/review/counts` | user | – | `Record<ReviewType, number>` |
| GET | `/review` | user | `?type&page` | `Paged<ReviewItem>` |
| **AI** |||||
| POST | `/companies/:id/ai/regenerate` | user | – | 202 |
| PATCH | `/companies/:id/ai` | user | `{ action: 'save' \| 'approve' \| 'reject', fields?, reason? }` | `CompanyAi` |
| POST | `/contacts/:id/ai/regenerate` | user | – | 202 |
| PATCH | `/contacts/:id/ai` | user | same as company | `ContactAi` |
| **Exports** |||||
| GET | `/exports/:kind/count` | user | `CompanyFilters` | `{ rows }` |
| GET | `/exports/:kind.csv` | user | `CompanyFilters` + `version=initial\|final` | CSV file download |
| GET | `/exports/log` | user | `?page` | `Paged<ExportLogEntry>` |
| **Email verification** |||||
| POST | `/verification/run` | admin | `{ edition }` | 202 |
| **Reports & settings** |||||
| GET | `/reports/gap` | user | `?edition` | `GapReport` |
| GET | `/reports/gap.csv` | user | `?edition` | CSV |
| GET | `/settings/providers` | user | – | `Providers` |
| GET | `/suppressions` | admin | – | `Suppression[]` |
| POST | `/suppressions` | admin | `{ value, reason? }` (email or domain) | `Suppression` |
| DELETE | `/suppressions/:id` | admin | – | 204 |
| **System** |||||
| GET | `/health` | anyone | – | `{ ok, mongo, redis, workers }` |
| POST | `/cron/:task` | GitHub Actions (`x-cron-secret` header) | – | 202 |

---

## Joint tickets

These are the only tickets that need both of you. None of them stops either person from moving on.

**J-0.1 Freeze the API contract**
Both read the contract section, push back on anything unclear, and agree on it. After that, frontend builds mocks from it and backend builds routes to it.
- [ ] Both have approved the contract PR in both repos

**J-1 … J-6 Integration check (one per phase)**
Once both sides of a phase are merged, run the frontend with `VITE_API_MOCK=false` against the backend, either locally or on Render. Click through that phase's screens. Whichever side differs from the contract fixes it. The next phase can start before this is done.
- [ ] Every screen in the phase works on real data
- [ ] Mismatches are fixed or logged as issues
- [ ] That phase's acceptance tests pass end to end

## Working agreements

- **One ticket = one branch = one PR.** Name branches like `be-1.4-directory` or `fe-2.3-review-queue`. Put the ticket ID in the PR title.
- **`main` is protected.** CI must pass. Squash merge. Self-merge is fine; tag the other person on anything that touches the contract.
- **Turn tickets into GitHub Issues** with the same IDs. Track them on one GitHub Project board with the columns Todo / Doing / Review / Done.
- **Definition of done for every ticket:** its acceptance checklist is ticked, CI is green, logic has tests, docs/README are updated where relevant, and nothing secret or personal is committed.
- **The repos are public.** Never commit `.env` files, real contact data, CSV exports, database dumps or API keys. Test fixtures use fake names and `example.com`.

## Decisions we still need

1. Which paid tools do we **already** have and are allowed to use? Sales Navigator seat, ContactOut (API or only the browser extension?), MillionVerifier credits, an AI API key.
2. Has ADIPEC's exhibitor list been confirmed OK to collect automatically? Gate 1 needs this.
3. Is Vercel Hobby OK for an internal company tool? If not, the frontend goes on a Render Static Site. Same build, no code change.
4. If an AI free tier (Gemini / Groq) is used, does the admin approve sending contact names and titles to it? Free tiers may train on inputs.

Until these are answered, the matching steps run in "Pending Access" mode, so nothing waits on them.
