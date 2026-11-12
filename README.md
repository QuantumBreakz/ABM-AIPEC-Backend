# ABM-AIPEC Backend

API + background workers for the ADIPEC lead-generation system. The full plan and ticket list are in [PLAN.md](PLAN.md). This file explains **how the code works** and **how to run it**.

Status: **Phase 0 (foundations) and Phase 1 (exhibitors) are built.** The website step comes next (Phase 2).

---

## The big picture

```
                    Vercel (frontend)
                         │  /api/*  (rewrite, same-site cookie)
                         ▼
┌──────────────── Render free web service (one Node process) ───────────────┐
│                                                                           │
│   Express API  ──── reads/writes ────►  MongoDB Atlas  (the real record)  │
│        │                                     ▲                            │
│        │ start run                           │ every step writes its      │
│        ▼                                     │ status + reason here       │
│   BullMQ queues ──► workers: directory ─► profile ─► (website, Phase 2)   │
│        ▲                                                                  │
│        └── Render Key Value (Redis): just the to-do list, may be wiped    │
└───────────────────────────────────────────────────────────────────────────┘
        ▲                                   │
        │ /health every 10 min,             │ polite HTTP (robots.txt,
        │ /cron/:task on a schedule         │ 1.5 s spacing, SSRF guard)
   GitHub Actions                           ▼
                                      adipec.com JSON endpoints
```

Three ideas run through everything:

1. **Mongo is the truth, Redis is a to-do list.** Render's free Redis loses its data on restart. So queueing a step first marks it `in_progress` in Mongo, and on boot we rebuild the queue from Mongo (`requeueUnfinished`). Run counts are always computed from Mongo.
2. **A company never gets dropped.** Every step ends with `setStep(company, step, status, reason)`, whether it worked or not, and the company moves on to the next step. A job that fails 3 times is marked `failed` with the error as the reason.
3. **People win over robots.** Any edit a person makes goes through `saveWithHistory()`. It logs the old value and *locks* the field, and workers skip locked fields.

## What happens when you start a run

1. `POST /runs { edition: 2026 }` (admin) creates a `Run` and queues one `directory` job.
2. **Directory step** (`src/pipeline/steps/directory.ts`):
   - reads the advertised count from the list page, and loads the category tree
   - calls `getallexhibitorslist`, keeps rows for the edition, and upserts one company per normalised name
   - saves the listing (stand, country, profile link) inside the company
   - records `discovered` and `duplicates` on the run, then queues `profile` for every company
3. **Profile step** (`src/pipeline/steps/profile.ts`), one job per company:
   - fetches each of its listings with `getExhibitorById` and saves description, categories, website, socials and address
   - status is `completed`, or `partial` with a reason like *"Profile has no website, description"*, or `restricted` if the site blocked us
   - then queues the next step, if it exists yet (website, Phase 2)
4. When nothing in the run is still `in_progress`, the run is marked `completed`.

Pause / resume (`POST /runs/:id/pause`, `/resume`) pause every BullMQ queue. Jobs already running finish; new ones wait.

## Folder map

```
src/
  index.ts              boot: env → Mongo → indexes → workers → requeue → listen; graceful shutdown
  app.ts                Express app (no listen, so tests import it): middleware + routes
  env.ts                every env var, checked with zod at startup
  contract.ts           API contract types copied from PLAN.md, the shapes the API must return
  db/
    models.ts           Mongo collections + indexes + lean doc types
    helpers.ts          setStep(), saveWithHistory(), refreshContactStats(), completenessOf()
    mappers.ts          DB documents → contract shapes (toCompany, toListItem, toRun, …)
  lib/
    fetcher.ts          the only way we touch the web: robots, politeness, SSRF guard, size/time limits
    normalize.ts        company names, URLs, domains → stable keys
    auth.ts             JWT cookie sessions, requireAuth, requireRole
    errors.ts           HttpError helpers + the one error response shape
    logger.ts           pino (JSON in prod, pretty locally, secrets redacted)
  sources/adipec.ts     everything specific to adipec.com: URLs + pure parsing functions
  pipeline/
    queue.ts            BullMQ queues, enqueue(), workers, pause/resume
    runs.ts             start/pause/resume runs, step chaining, counts, failure handling, requeue on boot
    steps/              directory.ts, profile.ts (more steps land here)
    index.ts            wires steps to queues
  routes/               auth, users, events, runs, companies, stats, system (health + cron)
scripts/                seed.ts (fake data), create-admin.ts
test/                   unit + API + pipeline tests; fixtures/ use invented data
docs/adipec-source.md   what we learned about the ADIPEC site
```

## Endpoints built so far

| | |
|---|---|
| Public | `GET /health`, `POST /cron/:task` (secret header), `POST /auth/login`, `POST /auth/logout` |
| Logged in | `GET /auth/me`, `GET /events`, `GET /runs`, `GET /runs/:id`, `GET /companies` (all filters), `GET /companies/:id`, `GET /stats/overview` |
| Admin | `/users` CRUD, `POST /events`, `POST /runs`, `POST /runs/:id/pause`, `POST /runs/:id/resume` |

Everything follows the contract in PLAN.md: error shape, paging, field names.

---

## Run it locally

You need Node 22+, MongoDB and Redis.

```bash
brew install mongodb-community redis   # once
brew services start mongodb-community
brew services start redis
```

```bash
cp .env.example .env          # then fill JWT_SECRET and CRON_SECRET (command in the file)
npm install
npm run seed                  # 150 fake companies in every state + 2 runs
npm run create-admin -- you@example.com
npm run dev                   # API + workers on http://localhost:4000
```

Try it:

```bash
curl -c /tmp/c -H 'content-type: application/json' -d '{"email":"you@example.com","password":"…"}' localhost:4000/auth/login
curl -b /tmp/c 'localhost:4000/companies?country=norway&pageSize=5'
curl -b /tmp/c localhost:4000/stats/overview
```

To do a **real** run against adipec.com locally: `POST /events` for 2026, then `POST /runs`. Read `docs/adipec-source.md` first. A full run takes about 50 minutes.

## Checks

```bash
npm test          # needs local Mongo + Redis; each test file gets its own throwaway database
npm run typecheck
npm run lint      # Biome; `npm run lint:fix` to auto-fix
```

CI runs all of these plus `npm audit` and a gitleaks secret scan on every PR.

## Deploying (BE-0.2)

1. **MongoDB Atlas.** Create a free M0 cluster and a database user with a long random password. Under Network Access, allow `0.0.0.0/0`, because Render's free plan has no fixed IP. Copy the connection string and add a database name, e.g. `/adipec`.
2. **Render.** New → Blueprint → pick this repo. It reads `render.yaml` and creates the web service and the Key Value. Paste `MONGO_URL` when asked. `JWT_SECRET` and `CRON_SECRET` are generated for you.
3. **First admin.** Point your local `.env` `MONGO_URL` at Atlas and run `npm run create-admin -- you@company.com`.
4. **GitHub.** Settings → Secrets and variables → Actions:
   - Variable `BACKEND_URL` = your Render URL. This turns on the keep-alive ping.
   - Secret `CRON_SECRET` = copy it from Render's environment tab.
5. **Protect `main`.** Settings → Branches → require the `ci` checks to pass.
6. Tell Faseeh the Render URL for the Vercel rewrite.

## Things to know

- **The repo is public.** Never commit `.env`, real contact data, CSVs or dumps. `.gitignore` blocks the common ones, and gitleaks checks every PR.
- **Free-tier ceilings** are marked in the code with `ponytail:` comments, each naming the limit and what to change on a paid plan.
- **Running the API and workers in one process** is deliberate (Render free has no workers). On a paid plan, split it by running `startPipeline()` in a separate background-worker service.
