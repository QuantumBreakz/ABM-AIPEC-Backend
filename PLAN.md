# ADIPEC Lead Gen — Build Plan v2

**Backend — Ali Ahmed** → https://github.com/QuantumBreakz/ABM-AIPEC-Backend
**Frontend — Faseeh** → https://github.com/QuantumBreakz/ABM-AIPEC-Frontend

Based on the PTC v3.0 doc (11 Nov 2026). Codes like FR-05 or AT-03 point back to it.

---

## 1. What we're building, in one breath

We pull every exhibitor from the ADIPEC site, read their website, find their decision-makers (with a human doing the Sales Navigator part), find emails, write AI drafts, export a first CSV, check the emails, and export a final CSV. Every company stays in the system even when a step fails. Every step shows why it stopped.

---

## 2. Where it runs (all free)

| Piece | Where | Free limit that matters | How we live with it |
|---|---|---|---|
| Frontend | Vercel (Hobby) | Hobby is meant for non-commercial use | Fine for building and demos. If that becomes a problem, move the same build to a Render Static Site (also free). No code change. |
| Backend API **+ workers** | Render, 1 free web service | No free background workers. Sleeps after 15 min with no traffic. Takes ~1 min to wake. 512 MB RAM. 750 hrs/month per workspace. | API and BullMQ workers run in the **same process**. GitHub Actions pings it to keep it awake while a run is going. One always-on service ≈ 744 hrs/month, so this is our **only** free service on Render. |
| Queue (Redis) | Render Key Value, free | Only one per workspace. Memory only, small. **Data is wiped on restart.** | Redis is just a to-do list. MongoDB is the real record. On every boot the backend re-queues anything unfinished. Job data is only `companyId`, and finished jobs are removed. Set it to `noeviction`, because BullMQ breaks if Redis drops keys. |
| Database | MongoDB Atlas M0 | 512 MB storage. No backups. | Store facts and links, never raw HTML. Rough size for 2,250 companies is well under 100 MB. Weekly `mongodump` through GitHub Actions to a private place (not the public repo). |
| Cron | GitHub Actions (free on public repos) | Schedules can lag 5–15 min. Scheduled workflows pause after 60 days with no commits. | Actions calls `POST /cron/<task>` with a secret header, and the backend queues the work. More reliable than in-Redis cron, because Redis can be wiped. |
| Heavy scraping (only if needed) | GitHub Actions job | 7 GB RAM, 6 hr per job | If the ADIPEC list needs a real browser, a Playwright script runs here and writes to Mongo. Render's 512 MB can't run Chrome comfortably. |
| AI | An already-approved key, or a free tier (Gemini / Groq) | Rate limits. Free tiers may use your data for training. | The worker slows down when it hits limits and picks up again later. Get admin sign-off before using a free tier with contact data. No key = "Personalization Pending". |
| Email check | Built-in MX lookup (free) + MillionVerifier if credits exist | MX alone can't prove an inbox exists | MX lookup only gives `invalid` or `unknown`. `verified` only ever comes from MillionVerifier. |

**Repos are public.** Never commit `.env`, CSV exports, Mongo dumps, or real contact data. All secrets go in Render/Vercel env vars and GitHub Secrets.

---

## 3. Tech stack

**Backend:** Node 22, TypeScript, Express, Mongoose, BullMQ, ioredis, undici + cheerio for scraping, zod for input checks, `csv-stringify` for streaming exports, bcrypt + JWT in an httpOnly cookie.

**Frontend:** Vite + React + TypeScript, React Router, TanStack Query (data) + TanStack Table (big lists), Tailwind.

**Login across Vercel and Render:** Vercel rewrites `/api/*` to the Render URL, so the browser thinks it's one site. Cookies just work, and there's no CORS setup.

```json
// frontend/vercel.json
{ "rewrites": [
  { "source": "/api/:path*", "destination": "https://<render-app>.onrender.com/:path*" },
  { "source": "/(.*)", "destination": "/index.html" }
]}
```

---

## 4. The pipeline (backend)

Each step is a BullMQ queue. Each job is one company. The job id is `step-companyId`, so running it twice does nothing.

| # | Step | Automatic? | Ends with |
|---|---|---|---|
| 1 | List exhibitors | Yes | Company rows + found-vs-advertised count |
| 2 | Open each exhibitor profile | Yes | Stand, category, country, description, website link |
| 3 | Read company website | Yes (cheerio, max ~8 pages) | Summary, services, markets, facts with source links |
| 4 | Find social links | Yes | LinkedIn, X, FB, IG, YouTube URLs |
| 5 | Match & dedupe | Yes; unclear cases go to review | Duplicate flag |
| 6 | Sales Navigator account + CXOs | **No — a human does it** (LinkedIn rules, NFR-07) | Reviewer task → contacts entered in our app |
| 7 | Email lookup | Only if ContactOut is already licensed | Emails with source, or "Pending Access" |
| 8 | AI write-up | If an approved key exists | Summary, signal, hypothesis, hyper-personalization, subject, email draft, LinkedIn draft |
| 9 | First CSV | Yes | Emails marked "Not Checked" |
| 10 | Email check (batch) | MX free, MillionVerifier if credits exist | verified / invalid / risky / unknown / not_checked |
| 11 | Final CSV | Yes | Same as the first CSV, plus check results and dates |

**Rules every worker follows:**
- Never drop a company. Always write the step's status and reason, then move on to the next step.
- Upsert, never blind insert.
- Edits a reviewer can see go through one `saveWithHistory()` helper, which keeps the old value.
- Every fact keeps its source URL and whether it's a *fact* or a *guess*.
- Unknown means an explicit status, never an empty cell that looks like success.
- Low concurrency (2–3 jobs) and a polite delay per domain, because the server is small.

**Statuses** (tracked separately per step: profile, website, social, account, people, emails, verification, personalization):
`not_started, in_progress, completed, partial, needs_review, pending_access, restricted, failed, approved`

---

## 5. Data (MongoDB)

- **events** — edition, directory URL, advertised count (2,250+)
- **companies** — name (raw + normalized), domain, ADIPEC profile per edition, website facts + sources, socials, Sales Nav link, leadership coverage, per-step status, AI fields + versions, duplicate flag, completeness score
- **contacts** — belongs to a company. Name, title, seniority, profile URL, match confidence, source, a list of emails (each with its check status), AI drafts + versions.
- **runs** — who started it, status, counts (discovered / attempted / completed / partial / restricted / failed / duplicate), errors
- **history** — what changed, old value, new value, who, when
- **users** — email, password hash, role (`admin` / `reviewer`)
- **suppressions** — opted-out emails or domains, left out of every export

Unique indexes: `companies.domain`, `companies.normalizedName + event`, `contacts.companyId + profileUrl`.

---

## 6. API contract (Ali writes this first so Faseeh isn't blocked)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` |
| Users (admin) | `GET /users` · `POST /users` · `PATCH /users/:id` · `DELETE /users/:id` |
| Overview | `GET /stats/overview` |
| Runs | `GET /runs` · `POST /runs` · `GET /runs/:id` · `POST /runs/:id/pause` · `POST /runs/:id/resume` |
| Companies | `GET /companies?q&category&country&step&status&hasContacts&emailStatus&approved&page` · `GET /companies/:id` · `PATCH /companies/:id` · `DELETE /companies/:id` |
| Contacts | `POST /companies/:id/contacts` · `POST /companies/:id/contacts/import` (pasted CSV) · `PATCH /contacts/:id` · `DELETE /contacts/:id` |
| Review queue | `GET /review?type=website\|duplicate\|salesnav\|contacts\|emails\|ai` |
| AI | `POST /companies/:id/ai/regenerate` · `POST /contacts/:id/ai/regenerate` · `PATCH /…/ai` (edit / approve / reject) |
| Exports | `GET /exports/companies.csv` · `/contacts.csv` · `/outreach.csv?version=initial\|final` (same filters as the list) |
| Reports | `GET /reports/gap` (JSON + CSV) |
| Settings | `GET /settings/providers` (which of ContactOut / MillionVerifier / AI are switched on) |
| Cron (Actions only) | `POST /cron/:task` with an `x-cron-secret` header · `GET /health` |

Ali puts this in `API.md` with sample JSON in week 1. Faseeh builds against those samples until the real endpoints land.

---

## 7. Backend plan — Ali

| Module | What it does | PTC |
|---|---|---|
| **B0 Setup** | Express app, Mongo + Redis connections, BullMQ workers started in the same process, `/health`, boot-time re-queue, `render.yaml`, `.env.example`, `.gitignore` | — |
| **B0 GitHub Actions** | `ci.yml` (typecheck + tests) · `keepalive.yml` (ping `/health` every 10 min) · `cron.yml` (nightly verify batch, weekly website refresh) · `backup.yml` (weekly mongodump) | — |
| **B1 Auth & users** | Login, roles, admin creates users, route guards | NFR-05 |
| **B2 Models** | Collections above, statuses, indexes, `saveWithHistory()` | NFR-02, 04 |
| **B3 Runs** | Start / pause / resume, counts, error log | FR-01, 08 |
| **B4 Directory + profiles** | Step 1–2. Start with a spike: does the ADIPEC list load from a JSON call we can fetch? If not, use the Actions + Playwright fallback. Check robots.txt / terms first. | FR-02, 03 |
| **B5 Website + socials** | Steps 3–4. Find the official domain, crawl a few key pages, pull facts with links | FR-04–07, 11 |
| **B6 Dedupe** | Name variants, same domain, across editions. Unclear cases go to review. | FR-10, NFR-06 |
| **B7 People** | Endpoints for the Sales Nav task, adding contacts, CSV paste import, leadership coverage flag | FR-12–16, 22 |
| **B8 Email lookup** | ContactOut adapter behind an on/off env flag | FR-17 |
| **B9 AI** | Builds a fact pack (sourced facts only), asks for JSON back, rejects anything without a cited URL ("Insufficient Evidence"), keeps versions, throttles itself | FR-23–31 |
| **B10 Exports** | Three streaming CSVs, initial + final, filters, Hyper-Personalization / Subject Line / Email Draft columns, suppressions removed | §6.3, AT-11 |
| **B11 Email check** | Batch job: syntax + MX, then MillionVerifier bulk if switched on | FR-18–21 |
| **B12 Reports & cleanup** | Gap report, suppression list, delete endpoints | NFR-08, §8.2 |

## 8. Frontend plan — Faseeh

| Module | What it does | PTC |
|---|---|---|
| **F0 Setup** | Vite app, routes, Tailwind, API client, login page, layout, `vercel.json`. A **"server is waking up…"** banner that retries for ~60s when Render is asleep. | — |
| **F1 Overview** | Totals: directory vs advertised, unique companies, profiles done, contacts, emails by status, AI drafts done, failures | §7.1 |
| **F2 Runs** | Start / pause / resume, progress bar, per-step results, error list. Polls every few seconds while a run is active. | §7.1 |
| **F3 Companies list** | Search, filters (year, category, country, step status, has contacts, email status, approved), sort, paging | §7.1, §6.3 |
| **F4 Company page** | ADIPEC info, website facts with source links, socials, contacts, AI fields, step statuses, history | §7.1 |
| **F5 Review queue** | Tabs: unclear website, possible duplicate, Sales Nav task (paste account URL, add CXOs, set coverage), missing contacts, odd emails, weak AI | FR-13–16, 22 |
| **F6 AI review** | Side by side: facts ↔ draft. Edit, approve, reject, regenerate. Show the approved version and its date. | FR-30 |
| **F7 Exports** | Pick company / contact / outreach, initial or final, same filters as the list, download | §7.1 |
| **F8 Admin** | Users and roles, provider on/off status, gap report view | NFR-05, 08 |

---

## 9. Order of work (rough, ~6 weeks)

| Week | Ali (backend) | Faseeh (frontend) | Gate |
|---|---|---|---|
| 1 | B0, B1, B2, `API.md`, ADIPEC spike | F0, F1 + F3 on sample data | — |
| 2 | B3, B4 | F2, F3 wired to real API | **Gate 1** — exhibitors + profiles with counts (AT-01, 02) |
| 3 | B5, B6 | F4, F5 (website / duplicate tabs) | **Gate 2** — website + socials (AT-03, AT-10) |
| 4 | B7, B8 | F5 (Sales Nav + contacts tabs) | **Gate 3** — people (AT-04, 05, 06, 09) |
| 5 | B9, B10 | F6, F7 | **Gate 5** — AI drafts + first CSV (AT-08, AT-11) |
| 6 | B11, B12 | F8, polish, empty/error states | **Gate 4 + 6** — email check, final CSV, all AT-01…12 |

If frontend finishes early, Faseeh can take **B10 Exports** or **B12 Reports**, since both are self-contained.

---

## 10. Need answers before week 4

1. Which paid tools do we **already** have and are allowed to use? Sales Nav seat, ContactOut (API or just the extension?), MillionVerifier credits, an AI key.
2. Is it OK to scrape the ADIPEC exhibitor list automatically? Gate 1 needs this.
3. Is Vercel Hobby OK for an internal company tool, or do we put the frontend on Render Static from day one?
