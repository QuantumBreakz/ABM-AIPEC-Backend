/**
 * Email lookup for a company's contacts (runs when contacts are added, or when a run asks for it).
 * Only contacts without a business email are looked up. Emails are never guessed (no first.last@ patterns).
 * Without ContactOut the step says so and reviewers add emails by hand (FR-17, FR-22).
 */
import type { Job } from 'bullmq';
import { refreshContactStats, setStep } from '../../db/helpers.js';
import { Contact } from '../../db/models.js';
import { env } from '../../env.js';
import { suppressedOf } from '../../lib/suppression.js';
import { contactoutEnabled, isLinkedInProfile, lookupWorkEmails, ProviderStop, takeLookup } from '../../providers/contactout.js';
import type { JobData } from '../queue.js';

export async function emailsStep(job: Job<JobData>) {
  const companyId = job.data.companyId!;
  const contacts = await Contact.find({ company: companyId }).lean();
  if (!contacts.length) return setStep(companyId, 'emails', 'not_started', 'No contacts yet');

  const need = contacts.filter((c) => !c.emails.some((e) => e.type !== 'generic'));
  if (!need.length) return setStep(companyId, 'emails', 'completed', `All ${contacts.length} contacts have an email`);
  if (!contactoutEnabled()) {
    return setStep(
      companyId,
      'emails',
      'pending_access',
      `ContactOut isn’t connected. ${need.length} contact(s) need an email added by hand.`,
    );
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
  if (stop) return setStep(companyId, 'emails', 'pending_access', `${stop}. ${notes.join('. ')}`);
  return setStep(companyId, 'emails', found === need.length ? 'completed' : 'partial', notes.join('. '));
}
