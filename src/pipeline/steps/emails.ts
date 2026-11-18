/**
 * Contact & email discovery for a company.
 * 1. Runs the free NitLead scraper (homepage + contact/team path probing + Cloudflare email decoding
 *    + DuckDuckGo OSINT + optional Hunter/Apollo/Snov) to discover contacts, emails, and phones.
 * 2. If ContactOut is connected and any contacts still lack a personal work email, looks them up via ContactOut.
 * 3. Chains onward to `personalization` when running inside a pipeline run.
 */
import type { Job } from 'bullmq';
import { refreshContactStats, setStep } from '../../db/helpers.js';
import { Company, Contact } from '../../db/models.js';
import { env } from '../../env.js';
import { suppressedOf } from '../../lib/suppression.js';
import { contactoutEnabled, isLinkedInProfile, lookupWorkEmails, ProviderStop, takeLookup } from '../../providers/contactout.js';
import { enrichAndSaveCompanyContacts } from '../enrichment.js';
import type { JobData } from '../queue.js';
import { continueAfter } from '../runs.js';

export async function emailsStep(job: Job<JobData>) {
  const companyId = job.data.companyId!;
  const runId = job.data.runId;
  const company = await Company.findById(companyId).lean();
  if (!company) return;

  const canScrape = Boolean(company.website?.url || company.domain || company.editions?.length);
  let contacts = await Contact.find({ company: companyId }).lean();

  if (!contacts.length) {
    if (canScrape) {
      await enrichAndSaveCompanyContacts(companyId);
      contacts = await Contact.find({ company: companyId }).lean();
      if (!contactoutEnabled() || !contacts.some((c) => !c.emails.some((e) => e.type !== 'generic'))) {
        await continueAfter('emails', companyId, runId);
        return;
      }
    } else {
      await setStep(companyId, 'emails', 'not_started', 'No contacts yet');
      await continueAfter('emails', companyId, runId);
      return;
    }
  }

  const need = contacts.filter((c) => !c.emails.some((e) => e.type !== 'generic'));
  if (!need.length) {
    await setStep(companyId, 'emails', 'completed', `All ${contacts.length} contacts have an email`);
    await continueAfter('emails', companyId, runId);
    return;
  }
  if (!contactoutEnabled()) {
    if (canScrape) {
      await enrichAndSaveCompanyContacts(companyId);
    } else {
      await setStep(
        companyId,
        'emails',
        'pending_access',
        `ContactOut isn’t connected. ${need.length} contact(s) need an email added by hand.`,
      );
    }
    await continueAfter('emails', companyId, runId);
    return;
  }

  let found = 0;
  let empty = 0;
  let noProfile = 0;
  let stop: string | undefined;
  for (const c of need) {
    if (!isLinkedInProfile(c.profileUrl)) {
      noProfile++;
      continue;
    }
    if (!(await takeLookup())) {
      stop = `Monthly ContactOut limit reached (${env.CONTACTOUT_MAX_LOOKUPS} lookups)`;
      break;
    }
    let emails: Awaited<ReturnType<typeof lookupWorkEmails>>;
    try {
      emails = await lookupWorkEmails(c.profileUrl!);
    } catch (e) {
      if (!(e instanceof ProviderStop)) throw e; // rate limit / outage: BullMQ retries; contacts already done are skipped
      stop = e.message;
      break;
    }
    const blocked = await suppressedOf(emails.map((e) => e.address));
    const known = new Set(c.emails.map((e) => e.address));
    const fresh = emails.filter((e) => !blocked.has(e.address) && !known.has(e.address));
    if (!fresh.length) {
      empty++;
      continue;
    }
    await Contact.updateOne(
      { _id: c._id },
      {
        $push: {
          emails: {
            $each: fresh.map((e) => ({
              address: e.address,
              type: 'business',
              provider: 'contactout',
              providerStatus: e.status,
              capturedAt: new Date(),
              verification: { status: 'not_checked' },
            })),
          },
        },
      },
    );
    found++;
  }
  await refreshContactStats(companyId);

  const notes = [
    `Found emails for ${found} of ${need.length} contact(s)`,
    empty ? `${empty} had none in ContactOut` : '',
    noProfile ? `${noProfile} have no LinkedIn profile link` : '',
  ].filter(Boolean);
  if (stop) await setStep(companyId, 'emails', 'pending_access', `${stop}. ${notes.join('. ')}`);
  else await setStep(companyId, 'emails', found === need.length ? 'completed' : 'partial', notes.join('. '));
  await continueAfter('emails', companyId, runId);
}
