/**
 * Step 2 — open each of the company's ADIPEC listings for this edition and save what the profile publishes:
 * stand, country, categories, description, website, socials, address. Missing things are named in the reason.
 */
import type { Job } from 'bullmq';
import { setStep } from '../../db/helpers.js';
import { Company, Event, Run } from '../../db/models.js';
import { FetchError, fetchJson } from '../../lib/fetcher.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { adipec, type Detail, type ParsedProfile, parseDetail } from '../../sources/adipec.js';
import type { JobData } from '../queue.js';
import { continueAfter } from '../runs.js';

export async function profileStep(job: Job<JobData>) {
  const { companyId, runId } = job.data;
  const company = await Company.findById(companyId).lean();
  if (!company) return;
  const run = runId ? await Run.findById(runId, { edition: 1 }).lean() : null;
  const edition = run?.edition ?? Math.max(...company.editions.map((e) => e.edition));
  const listings = company.editions.filter((e) => e.edition === edition);

  const finish = async (status: Parameters<typeof setStep>[2], reason?: string) => {
    await setStep(company._id, 'profile', status, reason);
    await continueAfter('profile', String(company._id), runId);
  };
  if (!listings.length) return finish('failed', `No ADIPEC ${edition} listing for this company`);

  const event = await Event.findOne({ edition }, { categoryPaths: 1 }).lean();
  const paths = new Map(Object.entries((event?.categoryPaths as unknown as Record<string, string>) ?? {}));

  const parsed: ParsedProfile[] = [];
  const problems: FetchError[] = [];
  for (const l of listings) {
    try {
      const p = parseDetail(await fetchJson<Detail>(adipec.detailUrl(l.sourceId)), paths);
      parsed.push(p);
      await Company.updateOne(
        { _id: company._id, editions: { $elemMatch: { edition, sourceId: l.sourceId } } },
        {
          $set: {
            'editions.$.stand': p.stand ?? l.stand,
            'editions.$.country': p.country ?? l.country,
            'editions.$.category': p.category,
            'editions.$.description': p.description,
            'editions.$.extra': { ...(l.extra instanceof Map ? Object.fromEntries(l.extra) : (l.extra ?? {})), ...p.extra },
            'editions.$.capturedAt': new Date(),
          },
        },
      );
    } catch (e) {
      if (e instanceof FetchError && e.retryable) throw e; // BullMQ retries the job later
      problems.push(e instanceof FetchError ? e : new FetchError('http', String((e as Error).message)));
    }
  }

  if (!parsed.length) {
    const blocked = problems.every((p) => p.kind === 'blocked' || p.kind === 'robots');
    return finish(blocked ? 'restricted' : 'failed', problems.map((p) => p.message).join('; '));
  }

  // Company-level fields: fill what the profile has, never overwrite what a person edited.
  const locked = new Set(company.lockedFields ?? []);
  const set: Record<string, unknown> = {};
  const website = parsed.find((p) => p.website)?.website;
  if (website && !locked.has('website.url')) set['website.url'] = website;
  for (const k of ['linkedin', 'facebook', 'instagram', 'x', 'youtube'] as const) {
    const v = parsed.find((p) => p.socials[k])?.socials[k];
    if (v && !locked.has(`socials.${k}`)) set[`socials.${k}`] = v;
  }
  if (Object.keys(set).length) await Company.updateOne({ _id: company._id }, { $set: set });

  const notes: string[] = [];
  const domain = normalizeDomain(website);
  if (domain && !company.domain && !locked.has('domain')) {
    try {
      await Company.updateOne({ _id: company._id }, { $set: { domain } });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const other = await Company.findOne({ domain }, { name: 1 }).lean();
      notes.push(`website domain ${domain} is already on "${other?.name}" (possible duplicate)`);
    }
  }

  // A field counts as missing only if no listing had it.
  const missing = ['website', 'description', 'country', 'category'].filter((f) => parsed.every((p) => p.missing.includes(f)));
  if (missing.length) notes.unshift(`Profile has no ${missing.join(', ')}`);
  if (problems.length)
    notes.push(`${problems.length} of ${listings.length} listings could not be read: ${problems.map((p) => p.message).join('; ')}`);
  return finish(notes.length ? 'partial' : 'completed', notes.join('. ') || undefined);
}
