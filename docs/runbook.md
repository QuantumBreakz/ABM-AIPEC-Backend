# Runbook

How to deploy, run and look after the backend. Written so someone who didn't build it can redeploy from scratch (BE-6.6).

## 1. Deploy from scratch

1. **MongoDB Atlas (free M0).**
   - Create a cluster and a database user with a long random password.
   - Network Access: allow `0.0.0.0/0`, because Render's free plan has no fixed IP.
   - Copy the connection string and add the database name: `…mongodb.net/adipec?retryWrites=true&w=majority`.
2. **Render.** New → Blueprint → this repo.
   - `render.yaml` creates the web service (API + workers) and the free Key Value (Redis, `noeviction`).
   - Paste `MONGO_URL` when asked. `JWT_SECRET` and `CRON_SECRET` are generated for you.
   - Wait for `/health` to answer `{"ok":true,…}`.
3. **First admin.** Put the Atlas URL in your local `.env` as `MONGO_URL`, then run `npm run create-admin -- you@company.com`.
4. **GitHub.** Settings → Secrets and variables → Actions:
   - Variable `BACKEND_URL` = the Render URL. This turns on the keep-alive ping and the cron jobs.
   - Secret `CRON_SECRET` = the value from Render → Environment.
   - For backups: variable `BACKUP_ENABLED=true`, secrets `MONGO_URL` and `BACKUP_AGE_PUBLIC_KEY` (see §5).
5. **Branch protection.** Settings → Branches → `main` → require the `ci` workflow (`check` and `secrets` jobs).
6. **Frontend.** Give Faseeh the Render URL for the Vercel `/api/*` rewrite.
7. **Create the event.** `POST /events { "edition": 2026, "name": "ADIPEC 2026", "directoryUrl": "https://www.adipec.com/exhibition/exhibitor-list/" }`, or from the Admin screen once it exists.

## 2. Environment variables

| Name | What | If missing |
|---|---|---|
| `MONGO_URL` | Atlas connection string | Server won't start |
| `REDIS_URL` | Render Key Value (set by the Blueprint) | Server won't start |
| `JWT_SECRET` | ≥ 32 random chars; signs login cookies | Server won't start |
| `CRON_SECRET` | ≥ 16 random chars; GitHub Actions sends it | Server won't start |
| `SCRAPER_USER_AGENT` | Our bot's name for websites | Default `SmartLogicsResearchBot/1.0` |
| `FETCH_DELAY_MS` | Gap between two requests to one site | 1500 |
| `CONTACTOUT_API_KEY` / `CONTACTOUT_MAX_LOOKUPS` | Work-email lookup, with a monthly cap | Email step says "ContactOut isn't connected"; people type emails |
| `MILLIONVERIFIER_API_KEY` / `MILLIONVERIFIER_MAX_CHECKS` | Mailbox check, with a monthly cap | Free MX check only (never "verified") |
| `LLM_API_KEY` / `LLM_MODEL` / `LLM_RPM` | Claude key for AI drafts, model (default `claude-opus-5-5`), requests a minute | Drafts stay "pending" |

**Only set a provider key the company already pays for** (zero-new-cost rule). Each provider is off until its key is set, and `GET /settings/providers` shows which are on.

## 3. Day-to-day

| Task | How |
|---|---|
| Full research run | Runs → Start run (all steps). About 50 min of ADIPEC calls, then the websites (1.5 s between requests per site). |
| Re-run one step | Start run with only that step ticked, e.g. `website` |
| Sales Navigator work | Review → Sales Nav tab. Add contacts by hand or paste a CSV |
| AI drafts | Run after website research, or "Regenerate" per company/contact. Review → AI tab for the ones that need a look |
| First CSV | Exports → `version=initial` (emails show "not_checked") |
| Email check | Exports → "Check emails" (`POST /verification/run`), or wait for the nightly cron |
| Final CSV | Exports → `version=final`, once the check run is completed |
| Gap report | `GET /reports/gap` (or `.csv`) |
| Opt-out request | Admin → Suppressions → add the email or the whole domain. It's never stored or exported again |
| Delete someone's data | `DELETE /contacts/:id` or `DELETE /companies/:id` (admin). History keeps only that a deletion happened |

Scheduled by GitHub Actions (`cron.yml`):
- `verify-emails`: nightly at 01:00 UTC.
- `refresh-websites`: Sundays at 02:00 UTC, 200 sites per run.
- `keepalive.yml`: pings every 10 minutes.

## 4. When things go wrong

| Symptom | Cause | Fix |
|---|---|---|
| First request takes ~1 min | Render free service was asleep | Normal. Check that `keepalive.yml` is running (repo variable `BACKEND_URL` set) |
| Run stuck "running", nothing moving | Redis was wiped and the server hasn't restarted | Restart the service in Render. On boot it re-queues everything still `in_progress` |
| A site shows `restricted` | The site's robots.txt or bot protection refused us | Expected. A person fills in what's needed (Review → Website tab). Never disguise the bot |
| ADIPEC directory step fails | Their API changed, or Incapsula started challenging us | Check `docs/adipec-source.md`. If it's a block, stop and ask; don't work around it |
| Emails step says "limit reached" | Monthly provider cap hit | Raise `CONTACTOUT_MAX_LOOKUPS` / `MILLIONVERIFIER_MAX_CHECKS` only if the plan allows, or wait for next month |
| AI drafts "pending" with "rejected the API key" | Key revoked or out of credit | Fix the key on Render; then Start run with only `personalization`, or Regenerate |
| Atlas near 512 MB | Free tier limit | Delete old editions' companies, or move to a paid tier. We store no raw HTML |
| 429 on login | 10 failed tries in 15 min for that IP + email | Wait 15 minutes |
| Export times out through Vercel | Very large file through the proxy | Narrow the filters, or download straight from the Render URL |

## 5. Backups

**Making the key (once):**
1. `brew install age`, then `age-keygen -o adipec-backup.key`.
2. Keep `adipec-backup.key` (the private key) in the company password manager, never in the repo.
3. Put the printed `age1…` public key in the GitHub secret `BACKUP_AGE_PUBLIC_KEY`.

**When it runs:** `backup.yml`, Mondays 03:00 UTC, or Actions → backup → Run workflow. It stores an encrypted artifact for 90 days.

**Restore:**
```bash
gh run download <run-id> --repo QuantumBreakz/ABM-AIPEC-Backend      # get the .age file
age -d -i adipec-backup.key adipec-YYYY-MM-DD.archive.gz.age > restore.archive.gz
mongorestore --uri="<target MONGO_URL>" --archive=restore.archive.gz --gzip --drop
```
Try a restore into a local Mongo once after setting this up, so you know it works.

## 6. Security checklist (BE-6.2)

- [x] Login cookie is httpOnly, Secure in production, SameSite=Lax. Sessions are re-checked against the database on every request.
- [x] Passwords: bcrypt, at least 8 characters. Failed logins are rate-limited (10 per 15 min per IP + email). The response time doesn't reveal which emails exist.
- [x] Roles: admin-only routes are enforced on the server, never only hidden in the UI. The last admin can't be removed.
- [x] Every request body and query is validated with zod. Unknown fields are rejected on edits, so nothing like `$set` can be injected. Search text is regex-escaped.
- [x] Exports hold contact data: logged (who, when, filters, rows) and rate-limited (20 a minute per user).
- [x] Outbound requests: robots.txt respected, no private/internal addresses (SSRF guard, re-checked on every redirect), size and time limits.
- [x] CSV formula injection neutralised. Opted-out emails are never stored or exported.
- [x] Logs are JSON, with cookies, auth headers and passwords redacted. No stack traces are sent to clients in production.
- [x] Secrets are only in Render, GitHub Secrets and local `.env` (git-ignored). gitleaks scans every PR, and `npm audit` (high) runs in CI.
- [x] Paid providers are off without a key and have hard monthly caps.
- [ ] Atlas: rotate the DB password if anyone leaves; consider a paid tier for IP allow-listing.
