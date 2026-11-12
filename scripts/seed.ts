/**
 * Fake data in every state, so every endpoint (and Faseeh's screens, when pointed at a local backend)
 * can be tried before the scrapers have run. All names are invented; domains use the reserved .example TLD.
 *
 *   npm run seed         add seed data (safe to run twice)
 *   npm run seed:reset   wipe companies/contacts/runs/events/history first (keeps users)
 *
 * Refuses to run when NODE_ENV=production.
 */
import mongoose from 'mongoose';
import { completenessOf, refreshContactStats } from '../src/db/helpers.js';
import { AI_STATUSES, Company, Contact, EMAIL_STATUSES, Event, History, Run, STATUSES, STEPS } from '../src/db/models.js';
import { env } from '../src/env.js';
import { normalizeName } from '../src/lib/normalize.js';

if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const EDITION = 2026;
const WORKER_STEPS: string[] = ['profile', 'website', 'social'];
const COUNT = 150;
const words1 = ['Example', 'Sample', 'Demo', 'Placeholder', 'Testing', 'Mock'];
const words2 = ['Drilling', 'Energy', 'Subsea', 'Pipeline', 'Valves', 'Robotics', 'Analytics', 'Coatings', 'Logistics', 'Marine'];
const forms = ['LLC', 'Ltd', 'FZE', 'GmbH', 'Inc', 'PJSC'];
const countries = ['United Arab Emirates', 'Saudi Arabia', 'United Kingdom', 'Norway', 'United States', 'India', 'Italy', 'China'];
const categories = ['O&G', 'Maritime', 'Decarbonisation', 'Digitalisation', 'Manufacturing'];
const firstNames = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie'];
const lastNames = ['Example', 'Sample', 'Placeholder', 'Demo', 'Tester'];
const titles = ['Chief Executive Officer', 'Chief Technology Officer', 'Chief Digital Officer', 'Head of Operations', 'IT Director'];

// Deterministic "random" so the seed is the same every time.
let n = 42;
const rand = () => {
  n = (n * 1103515245 + 12345) % 2 ** 31;
  return n / 2 ** 31;
};
const pick = <T>(xs: readonly T[], i?: number) => xs[i ?? Math.floor(rand() * xs.length)];

await mongoose.connect(env.MONGO_URL);
await mongoose.syncIndexes();

if (process.argv.includes('--reset')) {
  await Promise.all([Company.deleteMany({}), Contact.deleteMany({}), Run.deleteMany({}), Event.deleteMany({}), History.deleteMany({})]);
  console.log('Wiped companies, contacts, runs, events, history.');
}

await Event.updateOne(
  { edition: EDITION },
  { $setOnInsert: { name: 'ADIPEC 2026', directoryUrl: 'https://www.adipec.com/exhibition/exhibitor-list/', advertisedCount: 2260 } },
  { upsert: true },
);

const now = Date.now();
for (let i = 0; i < COUNT; i++) {
  const name = `${pick(words1, i % words1.length)} ${pick(words2, i % words2.length)} ${i + 1} ${pick(forms)}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Cycle through every status so each one appears at least once. Steps that have a real worker never get
  // `in_progress`: on boot the server would queue them and try to fetch fake companies from adipec.com.
  const stages = Object.fromEntries(
    STEPS.map((s, k) => {
      const cycled = STATUSES[(i + k) % STATUSES.length];
      const status = cycled === 'in_progress' && WORKER_STEPS.includes(s) ? 'completed' : cycled;
      const reason =
        status === 'completed' || status === 'not_started' ? undefined : `Seed: example reason for ${status.replace('_', ' ')}`;
      return [s, { status, reason, updatedAt: new Date(now - i * 60_000) }];
    }),
  );
  const hasWebsite = i % 7 !== 0;
  const doc = {
    name,
    normalizedName: normalizeName(name),
    originalNames: [name],
    domain: hasWebsite ? `${slug}.example` : undefined,
    editions: [
      {
        edition: EDITION,
        sourceId: `seed-${i}`,
        profileUrl: `https://www.adipec.com/exhibition/exhibitordetails?exhibitorid=seed-${i}`,
        stand: String(1000 + i),
        country: pick(countries),
        category: pick(categories),
        description: i % 5 === 0 ? undefined : `${name} is an invented company used as seed data.`,
        extra: { hall: `Hall ${1 + (i % 12)}` },
        capturedAt: new Date(now - i * 3_600_000),
      },
      ...(i % 10 === 0
        ? [
            {
              edition: 2025,
              sourceId: `seed-2025-${i}`,
              stand: String(900 + i),
              country: pick(countries),
              capturedAt: new Date(now - 4e10),
            },
          ]
        : []),
    ],
    website: hasWebsite
      ? {
          url: `https://${slug}.example/`,
          summary: `${name} makes example products for the energy sector.`,
          services: ['Example service A', 'Example service B'],
          markets: ['Middle East', 'Europe'],
          contactDetails: {
            emails: [`info@${slug}.example`],
            phones: ['+971 0 000 0000'],
            addresses: [],
            sourceUrl: `https://${slug}.example/contact`,
          },
          pagesReviewed: [{ url: `https://${slug}.example/`, fetchedAt: new Date() }],
          facts: [
            { text: `${name} offers example service A.`, sourceUrl: `https://${slug}.example/services`, kind: 'fact' },
            { text: `${name} may be expanding in the Gulf.`, sourceUrl: `https://${slug}.example/news`, kind: 'inference' },
          ],
        }
      : {},
    socials: i % 3 === 0 ? {} : { linkedin: `https://www.linkedin.com/company/${slug}`, x: i % 2 ? `https://x.com/${slug}` : undefined },
    leadershipCoverage: pick(['confirmed_partial', 'unknown', 'reviewed'] as const, i % 3),
    stages,
    ai: {
      status: AI_STATUSES[i % AI_STATUSES.length],
      summary: i % 5 === 1 ? undefined : `${name} provides example services. (Seed text.)`,
      signal: `Announced example service B.`,
      signalUrl: hasWebsite ? `https://${slug}.example/news` : undefined,
      hypothesis: 'They might benefit from automating example workflows.',
      hyperPersonalization: `Saw that ${name} recently announced example service B.`,
      evidenceUrls: hasWebsite ? [`https://${slug}.example/news`] : [],
    },
  };
  const company = await Company.findOneAndUpdate({ normalizedName: doc.normalizedName }, { $set: doc }, { upsert: true, returnDocument: 'after' });

  // 0–3 contacts per company, with emails in every verification status.
  const contactCount = i % 4;
  for (let c = 0; c < contactCount; c++) {
    const first = pick(firstNames, (i + c) % firstNames.length);
    const last = pick(lastNames, (i + c) % lastNames.length);
    await Contact.findOneAndUpdate(
      { company: company._id, profileUrl: `https://www.linkedin.com/in/seed-${i}-${c}` },
      {
        $set: {
          firstName: first,
          lastName: last,
          title: pick(titles, (i + c) % titles.length),
          seniority: c === 0 ? 'C-level' : 'Director',
          geography: pick(countries),
          matchConfidence: pick(['high', 'medium', 'low'] as const, c),
          source: 'seed',
          emails: hasWebsite
            ? [
                {
                  address: `${first}.${last}.${i}${c}@${company.domain}`.toLowerCase(),
                  type: 'business',
                  provider: 'seed',
                  verification: { status: EMAIL_STATUSES[(i + c) % EMAIL_STATUSES.length], checkedAt: new Date(), source: 'seed' },
                },
              ]
            : [],
          ai: {
            status: AI_STATUSES[(i + c) % AI_STATUSES.length],
            subject: `Question about ${name}`,
            draft: 'Seed draft text.',
            evidenceUrls: [],
          },
        },
      },
      { upsert: true },
    );
  }
  await refreshContactStats(company._id);
  const fresh = (await Company.findById(company._id).lean())!;
  await Company.updateOne({ _id: company._id }, { completeness: completenessOf(fresh) });
}

// Mark two companies as duplicates of the first one, so the duplicate filter and banner have data.
const [keep, ...rest] = await Company.find({}, { _id: 1 }).sort({ normalizedName: 1 }).limit(3).lean();
await Company.updateMany({ _id: { $in: rest.map((c) => c._id) } }, { duplicateOf: keep._id });

// One finished run and one paused run, so the Runs screen has something to show.
if (!(await Run.exists({ startedBy: 'seed' }))) {
  await Run.create([
    {
      edition: EDITION,
      status: 'completed',
      steps: ['directory', 'profile'],
      startedBy: 'seed',
      directoryDone: true,
      discovered: COUNT + 3,
      duplicates: 3,
      finishedAt: new Date(),
    },
    {
      edition: EDITION,
      status: 'paused',
      steps: ['profile'],
      startedBy: 'seed',
      directoryDone: true,
      errors: [{ step: 'profile', message: 'Seed: example error (HTTP 503)', companyName: 'Example Drilling 1 LLC', at: new Date() }],
    },
  ]);
}

console.log(`Seeded ${COUNT} companies, ${await Contact.countDocuments({ source: 'seed' })} contacts, 2 runs for edition ${EDITION}.`);
await mongoose.disconnect();
