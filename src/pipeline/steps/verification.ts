/**
 * Email check, one job per company (FR-18…21). Runs as a batch after the initial CSV:
 * from POST /verification/run or the nightly cron.
 *
 * Every email still `not_checked`, or last checked over 30 days ago, gets a status, a date and a source:
 *  - MillionVerifier when its key is set (the only way an email can become `verified`)
 *  - otherwise the free MX check, which can only say `invalid` or `unknown`
 * Never marks anything verified without a real check result. Opted-out emails are skipped.
 */
import type { Job } from 'bullmq';
import { refreshContactStats, setStep } from '../../db/helpers.js';
import { Contact } from '../../db/models.js';
import { env } from '../../env.js';
import { suppressedOf } from '../../lib/suppression.js';
import { millionVerifierEnabled, takeCheck, VerifierStop, verifyEmail } from '../../providers/millionverifier.js';
import { checkMx } from '../../providers/mx.js';
import type { JobData } from '../queue.js';

/** Results older than this are checked again: mailboxes close and domains lapse. */
export const RECHECK_AFTER_DAYS = 30;
const stale = () => new Date(Date.now() - RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000);

/** Emails that need a check: never checked, or checked more than RECHECK_AFTER_DAYS ago. */
export const needsCheck = (v?: { status?: string | null; checkedAt?: Date | null } | null) =>
  !v?.status || v.status === 'not_checked' || (!!v.checkedAt && v.checkedAt < stale());

/** Mongo filter for contacts with at least one email that needs a check. */
export const needsCheckFilter = () => ({
  $or: [{ 'emails.verification.status': 'not_checked' }, { 'emails.verification.checkedAt': { $lt: stale() } }],
});

export async function verificationStep(job: Job<JobData>) {
  const companyId = job.data.companyId!;
  const contacts = await Contact.find({ company: companyId, ...needsCheckFilter() }).lean();
  const todo = contacts.flatMap((c) =>
    c.emails.filter((e) => needsCheck(e.verification)).map((e) => ({ contactId: c._id, address: e.address })),
  );
  if (!todo.length) return setStep(companyId, 'verification', 'completed', 'No emails needed a check');

  const blocked = await suppressedOf(todo.map((t) => t.address));
  const useMv = millionVerifierEnabled();
  let checked = 0;
  let stop: string | undefined;
  for (const t of todo) {
    if (blocked.has(t.address)) continue;
    let result: { status: string; note: string };
    let source: string;
    if (useMv && !stop) {
      if (!(await takeCheck())) {
        stop = `Monthly MillionVerifier limit reached (${env.MILLIONVERIFIER_MAX_CHECKS} checks)`;
        continue;
      }
      try {
        result = await verifyEmail(t.address);
        source = `millionverifier: ${result.note}`;
      } catch (e) {
        if (!(e instanceof VerifierStop)) throw e; // outage: retry later; already-checked emails keep their result
        stop = e.message;
        continue;
      }
    } else if (!useMv) {
      result = await checkMx(t.address);
      source = `mx-check: ${result.note}`;
    } else continue;
    await Contact.updateOne(
      { _id: t.contactId, 'emails.address': t.address },
      { $set: { 'emails.$.verification': { status: result.status, checkedAt: new Date(), source } } },
    );
    checked++;
  }
  await refreshContactStats(companyId);

  if (stop) return setStep(companyId, 'verification', 'pending_access', `${stop}. ${checked} of ${todo.length} emails checked.`);
  if (!useMv) return setStep(companyId, 'verification', 'partial', 'MX check only: deliverability was not confirmed.');
  return setStep(companyId, 'verification', 'completed', `${checked} emails checked with MillionVerifier`);
}
