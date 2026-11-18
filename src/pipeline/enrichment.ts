/**
 * Applies NitLead scraping results to a Company and its Contacts in MongoDB.
 * Respects Suppression (opt-outs), lockedFields (human edits), and deduplicates contacts & emails.
 */
import { refreshContactStats, setStep } from '../db/helpers.js';
import { Company, Contact } from '../db/models.js';
import { log } from '../lib/logger.js';
import { normalizeDomain } from '../lib/normalize.js';
import { suppressedOf } from '../lib/suppression.js';
import { enrichCompanyWithNitLead } from '../sources/nitleadEnricher.js';
import { uniqueCi } from '../sources/website.js';

export type EnrichSummary = {
  contactsAdded: number;
  emailsAdded: number;
  phonesAdded: number;
  pagesScraped: number;
  sourcesUsed: string[];
};

export async function enrichAndSaveCompanyContacts(companyId: string): Promise<EnrichSummary> {
  const company = await Company.findById(companyId).lean();
  if (!company) return { contactsAdded: 0, emailsAdded: 0, phonesAdded: 0, pagesScraped: 0, sourcesUsed: [] };

  const locked = new Set(company.lockedFields ?? []);
  const latestEdition = company.editions?.at(-1);

  const result = await enrichCompanyWithNitLead({
    name: company.name,
    country: latestEdition?.country ?? undefined,
    domain: company.domain ?? undefined,
    websiteUrl: company.website?.url ?? undefined,
    existingEmails: company.website?.contactDetails?.emails ?? [],
    existingPhones: company.website?.contactDetails?.phones ?? [],
  });

  // Never store suppressed / opted-out emails.
  const allCandidateEmails = [...result.emails.map((e) => e.address), ...result.contacts.flatMap((c) => c.emails.map((e) => e.address))];
  const blocked = await suppressedOf(allCandidateEmails);

  const cleanResultEmails = result.emails.filter((e) => !blocked.has(e.address));

  // Merge newly discovered website URL, emails, and phones onto the company record (respecting lockedFields).
  const companySet: Record<string, unknown> = {};
  if (!company.website?.url && result.websiteUrl && !locked.has('website.url')) {
    const domain = result.domain ?? normalizeDomain(result.websiteUrl);
    const other = domain ? await Company.findOne({ domain, _id: { $ne: company._id } }, { _id: 1 }).lean() : null;
    if (!other) {
      companySet['website.url'] = result.websiteUrl;
      if (domain) companySet.domain = domain;
    }
  }

  const prevEmails = company.website?.contactDetails?.emails ?? [];
  const prevPhones = company.website?.contactDetails?.phones ?? [];
  const mergedEmails = uniqueCi([...prevEmails, ...cleanResultEmails.map((e) => e.address)], 15);
  const mergedPhones = uniqueCi([...prevPhones, ...result.phones], 10);
  const phonesAdded = Math.max(0, mergedPhones.length - prevPhones.length);

  if (mergedEmails.length > prevEmails.length || mergedPhones.length > prevPhones.length) {
    companySet['website.contactDetails.emails'] = mergedEmails;
    companySet['website.contactDetails.phones'] = mergedPhones;
    if (!company.website?.contactDetails?.sourceUrl && result.websiteUrl) {
      companySet['website.contactDetails.sourceUrl'] = result.websiteUrl;
    }
  }
  if (Object.keys(companySet).length) {
    await Company.updateOne({ _id: company._id }, { $set: companySet });
  }

  // Upsert discovered contacts without duplicating existing contacts or emails.
  const existingContacts = await Contact.find({ company: company._id }).lean();
  const existingAllEmails = new Set(existingContacts.flatMap((c) => c.emails.map((e) => e.address.toLowerCase())));
  let contactsAdded = 0;
  let emailsAdded = 0;

  for (const scraped of result.contacts) {
    const freshEmails = scraped.emails.filter((e) => !blocked.has(e.address));
    // Skip inbox-only contacts if all of their emails are already present on another contact
    if (scraped.isGenericInbox && freshEmails.every((e) => existingAllEmails.has(e.address))) continue;

    // Match existing contact by LinkedIn profileUrl or case-insensitive full name
    const match = existingContacts.find(
      (c) =>
        (scraped.profileUrl && c.profileUrl && c.profileUrl.toLowerCase() === scraped.profileUrl.toLowerCase()) ||
        (c.firstName.trim().toLowerCase() === scraped.firstName.toLowerCase() &&
          c.lastName.trim().toLowerCase() === scraped.lastName.toLowerCase()),
    );

    if (match) {
      const knownOnMatch = new Set(match.emails.map((e) => e.address.toLowerCase()));
      const toAdd = freshEmails.filter((e) => !knownOnMatch.has(e.address));
      if (toAdd.length) {
        const docs = toAdd.map((e) => ({
          address: e.address,
          type: e.type,
          provider: e.provider,
          capturedAt: new Date(),
          verification: { status: 'not_checked' as const },
        }));
        await Contact.updateOne({ _id: match._id }, { $push: { emails: { $each: docs } } });
        for (const e of toAdd) existingAllEmails.add(e.address);
        emailsAdded += toAdd.length;
      }
      continue;
    }

    const emailDocs = freshEmails.map((e) => ({
      address: e.address,
      type: e.type,
      provider: e.provider,
      capturedAt: new Date(),
      verification: { status: 'not_checked' as const },
    }));
    const created = await Contact.create({
      company: company._id,
      firstName: scraped.firstName,
      lastName: scraped.lastName,
      title: scraped.title,
      seniority: scraped.seniority,
      profileUrl: scraped.profileUrl,
      geography: latestEdition?.country ?? undefined,
      matchConfidence: scraped.matchConfidence,
      source: scraped.source,
      emails: emailDocs,
    });
    existingContacts.push(created.toObject() as (typeof existingContacts)[number]);
    for (const e of freshEmails) existingAllEmails.add(e.address);
    contactsAdded++;
    emailsAdded += emailDocs.length;
  }

  await refreshContactStats(company._id);

  // Update `people` stage if we discovered contacts and a reviewer hasn't already completed/approved it.
  const currentPeopleStatus = company.stages?.people?.status ?? 'not_started';
  const totalContacts = existingContacts.length;
  const hasNamedPerson = result.contacts.some((c) => !c.isGenericInbox);
  if (totalContacts > 0 && !['completed', 'approved'].includes(currentPeopleStatus)) {
    await setStep(
      company._id,
      'people',
      hasNamedPerson ? 'completed' : 'partial',
      hasNamedPerson
        ? `Found ${totalContacts} contact(s) via automated scraper (${result.sourcesUsed.join(', ') || 'website'})`
        : `Found ${totalContacts} company inbox contact(s) via automated scraper; review for named decision-makers`,
    );
  }

  const totalEmails = existingAllEmails.size;
  if (totalEmails > 0) {
    const withEmail = existingContacts.filter((c) => c.emails.length > 0).length;
    await setStep(
      company._id,
      'emails',
      withEmail === totalContacts ? 'completed' : 'partial',
      `Found ${totalEmails} email(s) across ${withEmail} of ${totalContacts} contact(s) (${result.sourcesUsed.join(', ') || 'website'})`,
    );
  } else if (totalContacts > 0) {
    await setStep(
      company._id,
      'emails',
      'partial',
      `Found ${totalContacts} contact(s) but no email addresses yet (scraped ${result.pagesScraped} page(s))`,
    );
  } else {
    await setStep(
      company._id,
      'emails',
      'needs_review',
      `No public emails or contacts found after scraping ${result.pagesScraped} page(s) and web search`,
    );
  }

  log.info(
    {
      companyId,
      name: company.name,
      contactsAdded,
      emailsAdded,
      phonesAdded,
      pagesScraped: result.pagesScraped,
      sources: result.sourcesUsed,
    },
    'NitLead contact enrichment finished',
  );

  return {
    contactsAdded,
    emailsAdded,
    phonesAdded,
    pagesScraped: result.pagesScraped,
    sourcesUsed: result.sourcesUsed,
  };
}
