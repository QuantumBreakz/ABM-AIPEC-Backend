# Cost declaration (AT-12, NFR-01)

Every external service the system can use, what it costs, and whether it is on. **Nothing here requires a new purchase.** A paid provider is used only if its key is set, and each has a hard monthly cap that the code enforces.

| Service | Used for | Plan | Cost to us | On? | Cap / limit |
|---|---|---|---|---|---|
| Render web service | API + workers | Free | $0 | Yes | 750 instance hours/month, sleeps after 15 min idle |
| Render Key Value | Job queue (Redis) | Free | $0 | Yes | Small, memory only, wiped on restart (the code rebuilds the queue from Mongo) |
| MongoDB Atlas | Database | M0 free | $0 | Yes | 512 MB, no built-in backups (we back up weekly, encrypted) |
| GitHub Actions | CI, keep-alive, cron, backups | Free on public repos | $0 | Yes | — |
| Vercel | Frontend | Hobby | $0 | Yes | Hobby is for non-commercial use; Render Static is the free fallback |
| adipec.com | Exhibitor directory | Public pages | $0 | Yes | Polite: 1.5 s between requests, robots.txt respected |
| Company websites | Research | Public pages | $0 | Yes | Polite; blocks are respected, never bypassed |
| Sales Navigator | Finding decision-makers | Existing seat, if any | Existing | Manual only | The system never automates LinkedIn |
| ContactOut | Work emails | Existing plan, if any | Existing credits | Off until `CONTACTOUT_API_KEY` is set | `CONTACTOUT_MAX_LOOKUPS` per month (default 50) |
| MillionVerifier | Mailbox check | Existing credits, if any | Existing credits | Off until `MILLIONVERIFIER_API_KEY` is set | `MILLIONVERIFIER_MAX_CHECKS` per month (default 500) |
| Claude API (Anthropic) | AI research notes and drafts | Existing key, if any | Per token | Off until `LLM_API_KEY` is set | `LLM_RPM` requests a minute (default 20); one company + its contacts per job |
| Free MX check | Email domain check | DNS | $0 | Always | — |

**AI cost note.** With a key, each company costs one request for the company draft plus one per contact (two if the first answer fails the checks). The default model is `claude-opus-5-5`. `LLM_MODEL` can point at a cheaper model if the key holder prefers; that's their decision.

**Open decision (PLAN.md):** which of ContactOut, MillionVerifier and an AI key already exist and are approved. Until then all three stay off, and the matching steps say "Pending Access" / "Not Checked" / "pending".
