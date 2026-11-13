# Acceptance tests (PTC §9) and release gates

Status on 13 Nov 2026. **Automated** = covered by `npm test` (runs in CI on every PR). **Live** = checked against the real site or the real frontend. **To do** = needs the real end-to-end sample run (BE-6.5), which waits on the open decisions in PLAN.md (ADIPEC permission, which paid keys exist).

| Test | What must be true | Evidence so far | Status |
|---|---|---|---|
| AT-01 Full directory enumeration | Every listing is represented or counted as failed/restricted; totals reconcile | `pipeline.test.ts` (directory + merges + skipped rows); live: 1,969 listings → 1,943 companies, advertised 2,260 shown separately (`docs/adipec-source.md`); gap report totals | Automated + live (sample) |
| AT-02 Company detail capture | Profile fields and original profile URL saved | `pipeline.test.ts` (profile step), `adipec.test.ts`; live: 15 real profiles | Automated + live (sample) |
| AT-03 Website & social research | Website data and official socials with sources; gaps flagged | `website.test.ts` (step against a local site, robots, parked, DNS); live: 4 real sites (2 read, 2 restricted) | Automated + live (sample) |
| AT-04 Account matching | Matching links the right account; ambiguous → review | `research.test.ts`, `api-phase23.test.ts` (Sales Nav hand-off, review queue, account link edits) | Automated |
| AT-05 CXO research | Many people per company; no "complete" claim from a limited panel | `api-phase23.test.ts` (contacts, CSV import, coverage flag) | Automated |
| AT-06 Contact enrichment | Emails only with source and availability status | `emails.test.ts` (ContactOut adapter, caps, no guessing, opt-outs) | Automated |
| AT-07 Email verification | After the initial CSV, a batch gives each email a sourced status; unchecked stay Not Checked | `phase456-api.test.ts` (MX check, MillionVerifier mapping, credit stop, verification run) | Automated |
| AT-08 AI personalization | Subject, hyper-personalization and draft from a documented fact; nothing invented | `personalization.test.ts` (facts by id, banned claims, retry, no facts / no model), `phase456-api.test.ts` (review flow) | Automated · real drafts **to do** (needs an AI key) |
| AT-09 Restricted stage | Run continues with Partial / Pending Access; company data kept | `emails.test.ts` (no key), `personalization.test.ts` (no model), `website.test.ts` (restricted), `pipeline.test.ts` (failures move on) | Automated |
| AT-10 Duplicate control | Re-running doesn't duplicate companies, people, emails or approved copy | `pipeline.test.ts` (re-run), `research.test.ts` (merge / not-duplicate), `api-phase23.test.ts` (re-import), `personalization.test.ts` (approved kept) | Automated |
| AT-11 Export format | Initial and final CSVs with company, contacts, socials, email/status, Hyper-Personalization, Subject Line, Email Draft, sources | `phase456-api.test.ts` (columns, BOM/CRLF, initial vs final, opt-outs, formula guard) | Automated |
| AT-12 Cost compliance | No new paid commitment | `docs/cost-declaration.md`; every paid provider is off without a key and has a hard cap | Documented |

## Release gates (PTC §10.2)

| Gate | Needs | Status |
|---|---|---|
| 1 Source proof | ADIPEC collection with permission and traceable counts | Built and live-checked. **Waiting on the permission decision.** |
| 2 Research proof | Website and social research accurate for an approved sample | Built. Needs a reviewer to sign off a sample (e.g. 50 companies). |
| 3 People proof | One permitted decision-maker workflow; restricted access labelled honestly | Built (manual Sales Nav flow + CSV). Needs a demo with a real reviewer. |
| 4 Verification proof | Email provenance and statuses accurate, including Not Checked | Built. A real check needs MillionVerifier credits (else MX-only). |
| 5 Personalization proof | Drafts individualised, referenced, reviewable | Built. Real drafts need an AI key. |
| 6 Delivery proof | Agreed export schema, no duplicates on re-run, cost gate met | Built and tested. Final sign-off after the sample run. |

## The sample run (BE-6.5)

Once the decisions are made:
1. Run the full pipeline on the real 2026 directory (or a filtered sample).
2. Do the Sales Nav step for ~20 companies.
3. Generate drafts.
4. Export initial → check emails → export final.
5. Record results per AT row above, with the gap report attached.
