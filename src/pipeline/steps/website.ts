/**
 * Step 3 — read the company's official website (home + up to 6 key pages) and save a summary, services,
 * markets, sourced facts, generic contact details and social links. Also sets the `social` step.
 * Then continueAfter('website') runs the duplicate check and the Sales Navigator hand-off.
 */
import type { Job } from 'bullmq';
import type { StepStatus } from '../../contract.js';
import { setStep } from '../../db/helpers.js';
import { Company } from '../../db/models.js';
import { FetchError, fetchPage } from '../../lib/fetcher.js';
import { normalizeDomain } from '../../lib/normalize.js';
import {
  factSentences,
  genericEmails,
  looksParked,
  offeringNames,
  type PageKind,
  pickPages,
  type ReadPage,
  readPage,
  type Socials,
  socialLinks,
  trimText,
  uniqueCi,
} from '../../sources/website.js';
import type { JobData } from '../queue.js';
import { continueAfter } from '../runs.js';

const SOCIAL_KEYS = ['linkedin', 'facebook', 'instagram', 'x', 'youtube'] as const;

/** Why a site couldn't be read, in words a reviewer understands, and what status that means. */
function describe(e: FetchError): [StepStatus, string] {
  switch (e.kind) {
    case 'robots':
      return ['restricted', 'The site’s robots.txt asks bots not to read it'];
    case 'blocked':
      return ['restricted', `The site blocked automated reading (${e.status ?? 'challenge page'})`];
    case 'dns':
      return ['failed', 'The website’s domain doesn’t exist'];
    case 'private_address':
    case 'bad_url':
      return ['needs_review', `The website address looks wrong: ${e.message}`];
    case 'http':
      return ['failed', `The website answered HTTP ${e.status}`];
    default:
      return ['failed', e.message];
  }
}

export async function websiteStep(job: Job<JobData>) {
  const { companyId, runId } = job.data;
  const company = await Company.findById(companyId).lean();
  if (!company) return;
  const id = String(company._id);
  const locked = new Set(company.lockedFields ?? []);
  const hasSocial = SOCIAL_KEYS.some((k) => company.socials?.[k]);

  const finish = async (status: StepStatus, reason: string | undefined, social: [StepStatus, string | undefined]) => {
    await setStep(id, 'website', status, reason);
    await setStep(id, 'social', ...social);
    await continueAfter('website', id, runId);
  };
  const socialFromProfile: [StepStatus, string] = hasSocial
    ? ['completed', 'From the ADIPEC profile']
    : ['partial', 'No website to look for social links'];

  const url = company.website?.url;
  if (!url) return finish('needs_review', 'No website on the ADIPEC profile. Add it by hand if you know it.', socialFromProfile);

  let home: Awaited<ReturnType<typeof fetchPage>>;
  try {
    home = await fetchPage(url);
  } catch (e) {
    if (!(e instanceof FetchError) || e.retryable) throw e; // BullMQ retries network blips
    const [status, reason] = describe(e);
    await Company.updateOne({ _id: id }, { $set: { 'website.skipped': [{ url, reason }] } });
    return finish(status, reason, socialFromProfile);
  }
  if (!home.contentType.includes('html')) return finish('failed', 'The website didn’t return a web page', socialFromProfile);

  const pages: (ReadPage & { kind: PageKind })[] = [{ ...readPage(home.body, home.url), kind: 'home' }];
  if (looksParked(pages[0])) return finish('failed', 'The website looks parked or for sale', socialFromProfile);

  const skipped: { url: string; reason: string }[] = [];
  for (const link of pickPages(home.body, home.url)) {
    try {
      const r = await fetchPage(link.url);
      if (pages.some((p) => p.url === r.url)) continue; // two links redirected to the same page
      if (r.contentType.includes('html')) pages.push({ ...readPage(r.body, r.url), kind: link.kind });
      else skipped.push({ url: link.url, reason: 'Not a web page' });
    } catch (e) {
      // One bad page never fails the whole company.
      skipped.push({ url: link.url, reason: e instanceof FetchError ? describe(e)[1] : String((e as Error).message) });
    }
  }

  const of = (...kinds: PageKind[]) => pages.filter((p) => kinds.includes(p.kind));
  const domain = company.domain ?? normalizeDomain(home.url);

  const about = of('about')[0];
  const summary =
    pages[0].description ?? (about?.paragraphs.length ? trimText(about.paragraphs.slice(0, 2).join(' ')) : undefined) ?? undefined;
  const services = offeringNames(
    of('services').flatMap((p) => [...p.headings, ...p.listItems]),
    25,
  );
  const markets = offeringNames(
    of('markets').flatMap((p) => [...p.headings, ...p.listItems]),
    15,
  );
  const facts = of('about', 'services', 'news', 'home')
    .flatMap((p) => factSentences(p).map((text) => ({ text, sourceUrl: p.url, kind: 'fact' as const })))
    .slice(0, 20);
  const contactPage = of('contact')[0];
  const contactDetails = {
    emails: uniqueCi(
      genericEmails(
        pages.flatMap((p) => p.emails),
        domain,
      ),
      10,
    ),
    phones: uniqueCi(
      pages.flatMap((p) => p.phones),
      10,
    ),
    addresses: uniqueCi(
      pages.flatMap((p) => p.addresses),
      5,
    ),
    sourceUrl: contactPage?.url ?? home.url,
  };
  const found: Socials = socialLinks(pages.flatMap((p) => [...p.hrefs, ...p.sameAs]));

  // Write what we found. Fields a person edited (lockedFields) are left alone.
  const set: Record<string, unknown> = {
    'website.pagesReviewed': pages.map((p) => ({ url: p.url, fetchedAt: new Date() })),
    'website.skipped': skipped,
    'website.facts': facts,
    'website.contactDetails': contactDetails,
  };
  const put = (path: string, value: unknown, ok: boolean) => {
    if (ok && !locked.has(path)) set[path] = value;
  };
  put('website.summary', summary, !!summary);
  put('website.services', services, services.length > 0);
  put('website.markets', markets, markets.length > 0);
  for (const k of SOCIAL_KEYS) put(`socials.${k}`, found[k], !!found[k] && !company.socials?.[k]);
  await Company.updateOne({ _id: id }, { $set: set });

  const missing = [!summary && 'a summary', !services.length && 'services', !facts.length && 'facts'].filter(Boolean);
  const notes = [
    missing.length ? `Couldn’t find ${missing.join(', ')} on the site` : '',
    skipped.length ? `${skipped.length} of ${pages.length + skipped.length} pages couldn’t be read` : '',
  ].filter(Boolean);
  const anySocial = hasSocial || SOCIAL_KEYS.some((k) => found[k]);
  return finish(
    notes.length ? 'partial' : 'completed',
    notes.join('. ') || `Read ${pages.length} pages`,
    anySocial ? ['completed', undefined] : ['partial', 'No social links visible on the site'],
  );
}
