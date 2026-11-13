import { afterAll, describe, expect, it } from 'vitest';
import { Company, Contact, History } from '../src/db/models.js';
import { closeQueues } from '../src/pipeline/queue.js';
import { checkDuplicates, markNotDuplicate, mergeCompanies, salesNavHandoff } from '../src/pipeline/research.js';

afterAll(() => closeQueues());

const make = (name: string, extra: object = {}) => Company.create({ name, normalizedName: name.toLowerCase(), ...extra });

describe('duplicate check', () => {
  it('flags the same website domain (never merges by itself)', async () => {
    const a = await make('Alpha Pumps', { domain: 'alphapumps.example' });
    const b = await make('Alpha Pumps Middle East', { website: { url: 'https://me.alphapumps.example/' } });
    await checkDuplicates(String(b._id));
    const after = (await Company.findById(b._id).lean())!;
    expect(String(after.duplicateOf)).toBe(String(a._id));
    expect(after.duplicateReason).toBe('Same website domain (alphapumps.example) as “Alpha Pumps”');
    expect(await Company.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
  });

  it('flags a near-identical name, ignores loose matches', async () => {
    const a = await make('Shandong Kerui Petroleum Gas Equipment');
    const b = await make('Shandong Kerui Petroleum Equipment');
    const c = await make('Kerui Robotics');
    await checkDuplicates(String(b._id));
    await checkDuplicates(String(c._id));
    expect(String((await Company.findById(b._id).lean())?.duplicateOf)).toBe(String(a._id));
    expect((await Company.findById(c._id).lean())?.duplicateOf).toBeUndefined();
  });

  it('remembers "not a duplicate" in both directions', async () => {
    const a = await make('Beta Valves', { domain: 'betavalves.example' });
    const b = await make('Beta Valves Trading', { website: { url: 'https://betavalves.example/' } });
    await checkDuplicates(String(b._id));
    await markNotDuplicate(String(b._id), 'ali@example.com');
    await checkDuplicates(String(b._id));
    expect((await Company.findById(b._id).lean())?.duplicateOf).toBeUndefined();
    expect((await Company.findById(a._id).lean())?.notDuplicateOf.map(String)).toEqual([String(b._id)]);
  });
});

describe('merge', () => {
  it('keeps every listing and contact, fills gaps, moves the domain, and records it', async () => {
    const into = await make('Gamma Subsea', {
      editions: [{ edition: 2026, sourceId: '1' }],
      website: { summary: 'Kept summary' },
    });
    const from = await make('Gamma Subsea Ltd Old', {
      domain: 'gammasubsea.example',
      editions: [
        { edition: 2026, sourceId: '1' },
        { edition: 2025, sourceId: '9' },
      ],
      website: { url: 'https://gammasubsea.example/', summary: 'Ignored, kept one wins' },
      socials: { linkedin: 'https://www.linkedin.com/company/gamma' },
      duplicateOf: null,
    });
    const third = await make('Gamma Copy', { duplicateOf: from._id });
    await Contact.create([
      {
        company: into._id,
        firstName: 'Sam',
        lastName: 'Example',
        source: 'manual',
        profileUrl: 'https://www.linkedin.com/in/sam',
        emails: [{ address: 'sam@a.example' }],
      },
      {
        company: from._id,
        firstName: 'Sam',
        lastName: 'Example',
        source: 'manual',
        profileUrl: 'https://www.linkedin.com/in/sam',
        emails: [{ address: 'sam@b.example' }],
      },
      { company: from._id, firstName: 'Kim', lastName: 'Sample', source: 'manual' },
    ]);

    await mergeCompanies(String(from._id), String(into._id), 'ali@example.com');

    const kept = (await Company.findById(into._id).lean())!;
    expect(await Company.exists({ _id: from._id })).toBeNull();
    expect(kept.editions.map((e) => `${e.edition}-${e.sourceId}`).sort()).toEqual(['2025-9', '2026-1']);
    expect(kept.domain).toBe('gammasubsea.example');
    expect(kept.website?.summary).toBe('Kept summary');
    expect(kept.website?.url).toBe('https://gammasubsea.example/');
    expect(kept.socials?.linkedin).toBe('https://www.linkedin.com/company/gamma');
    expect(kept.contactsCount).toBe(2);
    const sam = (await Contact.findOne({ company: into._id, firstName: 'Sam' }).lean())!;
    expect(sam.emails.map((e) => e.address).sort()).toEqual(['sam@a.example', 'sam@b.example']);
    expect(String((await Company.findById(third._id).lean())?.duplicateOf)).toBe(String(into._id));
    expect(
      await History.exists({ entityId: into._id, field: 'merge', before: 'Gamma Subsea Ltd Old', after: 'Gamma Subsea' }),
    ).toBeTruthy();
  });

  it('refuses to merge a company into itself', async () => {
    const a = await make('Self Merge');
    await expect(mergeCompanies(String(a._id), String(a._id), 'x')).rejects.toThrow('itself');
  });
});

describe('Sales Navigator hand-off', () => {
  it('queues untouched companies, never overrides a reviewer', async () => {
    const fresh = await make('Fresh Co');
    const done = await make('Done Co', { stages: { account: { status: 'completed', reason: 'Found by Ali' } } });
    await salesNavHandoff(String(fresh._id));
    await salesNavHandoff(String(done._id));
    expect((await Company.findById(fresh._id).lean())?.stages?.account?.status).toBe('pending_access');
    expect((await Company.findById(done._id).lean())?.stages?.account).toMatchObject({ status: 'completed', reason: 'Found by Ali' });
    expect((await Company.findById(done._id).lean())?.stages?.people?.status).toBe('pending_access');
  });
});
