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

## Notes for Faseeh (frontend side, nothing blocking)

1. **Step override dropdown** (FE-2.2): leave out `in_progress`. The backend refuses it (only the system queues work); the mock allows it.
2. **Country filter:** real ADIPEC data uses full names ("United Arab Emirates"), not codes. The "e.g. AE" placeholder won't match anything.
3. **Review `website` tab:** the backend also lists `restricted` sites (the site blocked our bot, so a person fills in the summary). Worth adding to the mock.
4. **Starting a run while another is *paused*:** the backend says 409 (queues are shared); the mock allows it.
5. **CSV import counts:** the backend counts a row as `updated` only if something changed, and an import only fills blanks (it never overwrites a reviewer's edits). The mock counts every existing person as updated.
6. **`/health` `workers`** is a number (worker count), not a boolean.
7. FE-0.2 `vercel.json` isn't in the repo yet. Production needs the `/api/*` rewrite to the Render URL.
