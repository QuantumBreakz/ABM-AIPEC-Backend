/**
 * Step 1 — list every exhibitor for the run's edition and upsert one company per distinct name.
 * Then queue the profile step for each. Re-running never creates duplicates (AT-10).
 */
import type { Job } from 'bullmq';
import { Company, Event, Run } from '../../db/models.js';
import { fetchJson, fetchPage } from '../../lib/fetcher.js';
import { log } from '../../lib/logger.js';
import { cleanText, normalizeName } from '../../lib/normalize.js';
import { adipec, type CategoryNode, categoryPaths, editionRows, type ListRow, parseAdvertisedCount } from '../../sources/adipec.js';
import type { JobData } from '../queue.js';
import { continueAfter, recordRunError } from '../runs.js';

export async function directoryStep(job: Job<JobData>) {
  const runId = job.data.runId!;
  const run = await Run.findById(runId).lean();
  if (!run) return;
  const event = await Event.findOne({ edition: run.edition }).lean();
  if (!event) throw new Error(`No event for edition ${run.edition}`);

  // Nice-to-haves first. If they fail we note it and carry on.
  try {
    const advertised = parseAdvertisedCount((await fetchPage(event.directoryUrl)).body);
    if (advertised) await Event.updateOne({ _id: event._id }, { advertisedCount: advertised });
  } catch (e: any) {
    await recordRunError(runId, { step: 'directory', message: `Could not read the advertised exhibitor count: ${e.message}` });
  }
  try {
    const tree = await fetchJson<CategoryNode[]>(adipec.categoriesUrl);
    await Event.updateOne({ _id: event._id }, { categoryPaths: categoryPaths(tree) });
  } catch (e: any) {
    await recordRunError(runId, { step: 'directory', message: `Could not load product categories: ${e.message}` });
  }

  // The list itself. Errors here throw, so BullMQ retries; after the last retry the run is marked failed.
  const data = await fetchJson<{ Result?: ListRow[] }>(adipec.listUrl, { maxBytes: 20 * 1024 * 1024 });
  const { kept, skipped } = editionRows(data.Result ?? [], run.edition);
  if (!kept.length) throw new Error(`Directory returned no ${run.edition} exhibitors (${skipped} other rows)`);

  const now = new Date();
  const companyIds = new Set<string>();
  // ponytail: ~3 queries per listing (~2k listings). Fine for one run; switch to bulkWrite if runs get frequent.
  for (const row of kept) {
    const name = cleanText(row.CompanyName)!;
    const sourceId = String(row.Id);
    const company = (await Company.findOneAndUpdate(
      { normalizedName: normalizeName(name) },
      { $setOnInsert: { name, normalizedName: normalizeName(name) }, $addToSet: { originalNames: name } },
      { upsert: true, returnDocument: 'after', lean: true },
    ))!;
    const listing = {
      stand: cleanText(row.StandNumber),
      country: cleanText(row.CountryName),
      profileUrl: adipec.profileUrl(row.Id),
      capturedAt: now,
    };
    // Update this listing in place if we've seen it before (keeps what the profile step found), else add it.
    const updated = await Company.updateOne(
      { _id: company._id, editions: { $elemMatch: { edition: run.edition, sourceId } } },
      { $set: Object.fromEntries(Object.entries(listing).map(([k, v]) => [`editions.$.${k}`, v])) },
    );
    if (!updated.matchedCount) {
      const extra = Object.fromEntries(
        Object.entries({
          hall: cleanText(row.Hall),
          sponsorType: cleanText(row.SponsorType),
          standOppId: row.StandOppId ?? undefined,
        }).filter(([, v]) => v),
      );
      await Company.updateOne({ _id: company._id }, { $push: { editions: { edition: run.edition, sourceId, ...listing, extra } } });
    }
    companyIds.add(String(company._id));
  }

  await Run.updateOne({ _id: runId }, { discovered: kept.length, duplicates: kept.length - companyIds.size, directoryDone: true });
  log.info({ runId, listings: kept.length, companies: companyIds.size, skipped }, 'directory done');

  for (const id of companyIds) await continueAfter('directory', id, runId);
}
