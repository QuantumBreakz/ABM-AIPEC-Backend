import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as C from '../src/contract.js';
import { completenessOf, refreshContactStats, saveWithHistory, setStep } from '../src/db/helpers.js';
import { toCompany, toListItem } from '../src/db/mappers.js';
import { Company, Contact, History } from '../src/db/models.js';

const newCompany = (name = 'Example Co') =>
  Company.create({ name, normalizedName: name.toLowerCase(), editions: [{ edition: 2026, sourceId: '1', capturedAt: new Date() }] });

describe('saveWithHistory', () => {
  it('records only changed fields and locks them for workers', async () => {
    const c = await newCompany('History Test');
    await Company.updateOne({ _id: c._id }, { 'website.url': 'https://a.example.com/' });

    await saveWithHistory(
      Company,
      c._id,
      { 'website.url': 'https://a.example.com/', 'socials.linkedin': 'https://linkedin.com/company/x' },
      'ali@example.com',
    );

    const history = await History.find({ entityId: c._id }).lean();
    expect(history.map((h) => [h.field, h.before ?? null, h.after])).toEqual([
      ['socials.linkedin', null, 'https://linkedin.com/company/x'],
    ]);
    const after = await Company.findById(c._id).lean();
    expect(after?.lockedFields).toEqual(['socials.linkedin']);
  });

  it('does not lock fields for system changes', async () => {
    const c = await newCompany('System Change');
    await saveWithHistory(Company, c._id, { 'website.summary': 'x' }, 'system');
    expect((await Company.findById(c._id).lean())?.lockedFields).toEqual([]);
  });
});

describe('setStep / completeness / contact stats', () => {
  it('sets a step with reason and refreshes completeness', async () => {
    const c = await newCompany('Step Test');
    await Company.updateOne({ _id: c._id }, { 'website.url': 'https://x.example.com/' });
    await setStep(c._id, 'profile', 'partial', 'Profile has no description');
    const after = (await Company.findById(c._id).lean())!;
    expect(after.stages?.profile).toMatchObject({ status: 'partial', reason: 'Profile has no description' });
    expect(after.completeness).toBe(completenessOf(after));
    expect(after.completeness).toBe(20); // listing + website
  });

  it('keeps contactsCount and emailStatuses in sync', async () => {
    const c = await newCompany('Contacts Test');
    await Contact.create([
      {
        company: c._id,
        firstName: 'A',
        lastName: 'B',
        source: 'manual',
        emails: [{ address: 'a@x.example.com', verification: { status: 'verified' } }],
      },
      { company: c._id, firstName: 'C', lastName: 'D', source: 'manual', emails: [{ address: 'c@x.example.com' }] },
    ]);
    await refreshContactStats(c._id);
    const after = (await Company.findById(c._id).lean())!;
    expect(after.contactsCount).toBe(2);
    expect([...after.emailStatuses].sort()).toEqual(['not_checked', 'verified']);
  });
});

describe('mappers', () => {
  it('produce contract shapes', async () => {
    const c = await newCompany('Mapper Test');
    const doc = (await Company.findById(c._id).lean())!;
    const item = toListItem(doc);
    const full = toCompany(doc, []);
    expectTypeOf(item).toEqualTypeOf<C.CompanyListItem>();
    expectTypeOf(full).toEqualTypeOf<C.Company>();
    expect(Object.keys(full.stages).sort()).toEqual([
      'account',
      'emails',
      'people',
      'personalization',
      'profile',
      'social',
      'verification',
      'website',
    ]);
    expect(full.stages.profile.status).toBe('not_started');
    expect(full.salesNav.searchUrl).toContain('linkedin.com/sales/search/company?keywords=Mapper%20Test');
    expect(full).not.toHaveProperty('normalizedName');
    expect(full).not.toHaveProperty('lockedFields', undefined);
  });
});
