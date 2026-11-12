# ADIPEC source — findings (BE-1.1)

Checked 12 Nov 2026 against `https://www.adipec.com/exhibition/exhibitor-list/`.

## How the list loads

The page is server-rendered HTML with an empty `<div id="app">`. A Vue app (`/scripts/exhibitorlist/vue-script-build.js`) fills it by calling JSON endpoints under `https://www.adipec.com/api/exhibitorproxy/`:

| Endpoint | What it returns | Size |
|---|---|---|
| `getallexhibitorslist` | **Every exhibitor in one response**, as `{ "Result": [...] }`. No pagination. | ~750 KB |
| `getExhibitorById?exhibitorid=<Id>` | One exhibitor's full profile | ~200 KB (most of it is the whole category tree, repeated in every response) |
| `getalllevelproductcategorieslist` | The product-category tree (id → name, nested) | ~230 KB |

Other endpoints exist (`getcountrieslist`, `GetFilteredDatanew`, …) but we don't need them.

The public profile page for an exhibitor is `https://www.adipec.com/exhibition/exhibitordetails?exhibitorid=<Id>`. We store that as `profileUrl`.

**Decision: plain HTTP fetch from Render.** No browser needed, so no Playwright-in-Actions fallback for now.

## Fields

**List row:** `Id`, `StandOppId`, `CompanyName`, `CountryName`, `CompanyLogo`, `StandNumber` (can be `"1450, 1460"`), `Hall`, `SponsorType`, `ProductCategory` (comma-separated category ids).

**Profile:** the list fields plus `Address`, `City`, `WebsiteLink` (often without `https://`), `Facebook`, `Twitter`, `LinkedIn`, `YouTube`, `Instagram`, `CompanyDescriptionTitle` (this is where the description usually is), `Description` (usually null), `ExhibitorType` (`Main Exhibitor` / `Co-exhibitor`), `Category` (the full tree, ignored). Several fields are always null in what we saw (`ProductGallery`, `PressReleases`, `Brochure`, `Videoes`).

Gotchas:
- Names and addresses often start with a non-breaking space (` `). `cleanText()` handles it.
- When an exhibitor wrote no description, the site fills in `"ADIPEC is an energy  event"`. We treat that as **missing**.
- Category ids are turned into readable paths using the category tree, e.g. `O&G > Downstream > Refinery > Equipment manufacture`.
- **Descriptions are cut at 240 characters by ADIPEC itself** (`CompanyDescriptionTitle`). The full company summary has to come from the website step (Phase 2).
- Many exhibitors chose no product categories, so "Profile has no category" is common and honest.

## Counts (2026 edition, on the day we checked)

| | Count |
|---|---|
| Advertised on the page ("explore 2,260 exhibitors") | **2,260** |
| Rows returned by `getallexhibitorslist` | 1,977 |
| Rows with a 2026 stand id (`ADIPEC26-…`) | **1,969** ← what we call *discovered* |
| Rows the public page shows | 1,959 (it hides 10 `ADIPEC26-JB-*` sponsor rows) |
| Companies after merging repeated names | **1,943** (26 listings belonged to a company already seen) |

So the advertised figure is about **300 higher** than what the directory actually lists. The PTC already says the 2,250+ figure is a reference, not a promise. The Overview and gap report show both numbers side by side.

**What we keep and skip:**
- **Kept:** every row whose `StandOppId` starts with `ADIPEC<yy>`. That includes the 10 `JB` rows the page hides, because they are real companies (Accenture, Deloitte, Nvidia, …) and the PTC says never drop a discovered exhibitor.
- **Skipped:** rows without that prefix. These are the site's own test banners (`DMGTEST…`, `JM1234`, …).
- **Merged:** listings with the same normalised company name become one company with several listings. The merge count is reported as "duplicates" on the run.

## Is it allowed?

- `robots.txt` disallows `/umbraco/`, `/bin/`, `/config/` and similar, but **not** `/api/` or `/exhibition/`. Our fetcher checks robots.txt on every run anyway.
- The data is what the public page shows to any visitor.
- The site is behind **Imperva/Incapsula** bot protection. Our requests went through with a clearly named User-Agent. If it ever starts answering with a challenge page instead of JSON, the fetcher reports `blocked`, the step is marked `restricted`, and **we do not try to get around it** (NFR-07).
- **Still needed:** a human decision on the site's terms of use (Plan → "Decisions we still need" #2). Gate 1 asks for collection "with permission".

## Load we put on their site

One list call, one category call, one page fetch, then one profile call per listing (~1,969), spaced 1.5 s apart. That's about **50 minutes and ~400 MB** per full run, mostly the category tree repeated inside each profile. Don't run full runs more often than needed. Re-running only `profile` for a few companies is cheap.

## Live check (12 Nov 2026)

We ran directory + profile locally against the real site and paused after about 15 profiles:
- **Directory:** 1,969 listings → 1,943 companies, 26 merged.
- **Profiles:** 15 fetched (8 completed, 7 partial: no category or no website), 0 blocked or failed.

The test database was dropped afterwards.

## Test fixtures

`test/fixtures/adipec/` has files in the **same shape** as these responses, but with invented companies and `.example` domains. No real data is committed (the repo is public).
