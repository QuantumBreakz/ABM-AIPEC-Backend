# Frontend ↔ backend integration

Checked 13 Nov 2026 against `ABM-AIPEC-Frontend` `main` @ `d534f2a` (FE Phase 0 + 1: shell/auth, overview, company list, runs).
The frontend is the reference: where the real backend and the frontend's mock backend (`src/mocks/handlers`) behaved differently, the backend was changed to match. `test/frontend-alignment.test.ts` guards these.

## Contract types

All 32 types in `src/contract.ts` and the frontend's `src/api/types.ts` were compared with TypeScript (each pair must be identical). **No differences.** The frontend has 5 helper types of its own (`RunStep`, `AiAction`, `AiPatch`, `ApiErrorCode`, `ApiErrorBody`); all match what the backend accepts.

## What changed in the backend to match

| Area | Before | Now (as the frontend expects) |
|---|---|---|
| `POST /runs` steps | only 5 runnable steps; anything else → 400 | any of `directory` + the 8 step keys; default = all 9 |
| `POST /runs` unknown edition | 404 | 400 "Pick an edition that exists" |
| Run `errors` | oldest first | newest first |
| `GET /companies?q=` | name, domain | also original names from other listings |
| `GET /companies?country=` | contains | exact, any case |
| `pageSize` > 200 | 400 | capped at 200 |
| `completeness` | share of known facts | completed/approved = 1, partial = ½, averaged over the 8 steps |
| `PATCH /companies/:id` | `""` rejected | `""` or `null` clears a field; coverage clears to `unknown` |
| Sales Nav account link | linkedin.com only | any http(s) link |
| History entries | `_merged`, `_notDuplicate`, state objects | `merge` (old name → kept name), `duplicateOf` (id → null), `stages.<step>` (status → status), `contact:<id>` (null → name / "updated" → name / name → null) |
| `POST /companies/:id/contacts`, same person | 409 | updates that contact, 200 (new → 201) |
| Contact optional fields | `""` rejected | `""` / `null` clears |
| CSV import | unknown columns ignored; provider `manual` | unknown columns → 400; imported emails get provider `csv_import` |
| Review `website` | needs_review | needs_review, failed (and restricted, see below) |
| Review `salesnav` | account or people waiting | account waiting, flagged duplicates left out |
| Review `contacts` | people done, 0 contacts | people needs_review/partial, 0 contacts |
| Review `emails` | one item per company | one item per invalid/risky/unknown email, with contact |
| Review `ai` | companies only | companies and contacts |
| Review order | oldest first | newest first |
| Users | password ≥ 10; self-delete / last admin → 400 | password ≥ 8; self-delete, last admin, duplicate email → 409 |

Also fixed while testing: resuming a run that had nothing left to do left it "running" forever. It now finishes right away.

## Integration check (J-1)

The real frontend (`VITE_API_MOCK=false`, Vite proxy → `localhost:4000`) against the real backend on seed data:

- Login (`/auth/me` 401 → login 200 → session cookie) ✔
- Overview: totals, advertised vs discovered, review badge ✔
- Companies: filters, sort, paging, step dots, email badges ✔
- Runs: list, run detail, live progress, errors ✔
- Start run with only some steps (e.g. Social profiles) → 202, started by the admin, completed ✔
- Start run while one is paused → 409, the backend's message is shown in the dialog ✔
- Resume a paused run → completes ✔
- No console errors besides the expected pre-login 401.

## Phases 4–6 (built straight from the frontend's mocks)

AI review (`src/mocks/handlers/ai.ts`), exports (`exports.ts`), verification and the gap report (`system.ts`, `stats.ts`) were built to the mock's rules from the start:
- **Same AI keys and actions.** Regenerating without a model leaves the draft pending with the mock's exact reason. You can't approve without a draft (409), and the approved copy is kept when regenerating.
- **History fields:** `ai.<action>` and `contact:<id>:ai.<action>`.
- **Same export column names**, same `initial` vs `final` rules, BOM + CRLF, formula guard, filename `<kind>-<version>.csv`, and the export log.
- **`POST /verification/run` starts a verification-only run.** Without MillionVerifier, emails get `unknown`/`invalid` with source `mx-check…`, and the step is `partial` with the mock's reason.
- **Gap report** JSON and CSV are in the mock's format (`gap-report-<edition>.csv`).

Small differences (additive, nothing to change):
- `POST /verification/run` also returns `runId`, so the UI can open the run.
- Contacts export leaves out opted-out emails (the mock never stores them in the first place).
- Contact AI drafts don't change the company's personalization step, same as the mock.

Re-checked on 13 Nov against `main` @ `510e08e` (now including FE-1.4 company detail): login, overview, companies and company detail (steps panel, ADIPEC tab with extra fields) all work on the real backend.

## Notes for Faseeh (frontend side, nothing blocking)

1. **Step override dropdown** (FE-2.2): leave out `in_progress`. The backend refuses it (only the system queues work); the mock allows it.
2. **Country filter:** real ADIPEC data uses full names ("United Arab Emirates"), not codes. The "e.g. AE" placeholder won't match anything.
3. **Review `website` tab:** the backend also lists `restricted` sites (the site blocked our bot, so a person fills in the summary). Worth adding to the mock.
4. **Starting a run while another is *paused*:** the backend says 409 (queues are shared); the mock allows it.
5. **CSV import counts:** the backend counts a row as `updated` only if something changed, and an import only fills blanks (it never overwrites a reviewer's edits). The mock counts every existing person as updated.
6. **`/health` `workers`** is a number (worker count), not a boolean.
7. **New in the contract (additive):** `CompanyFilters` gained `minCompleteness` (0–100) and `approved` (boolean) for PTC §6.3's "research completeness" and "approval" filters. Please add them to `src/api/types.ts`, the mock and the filter bar. The CSVs also gained extra columns at the end (§5.1/§6 fields); the mock's columns keep their positions.
8. FE-0.2 `vercel.json` isn't in the repo yet. Production needs the `/api/*` rewrite to the Render URL.
