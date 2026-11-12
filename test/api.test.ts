import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Company, Event, Run, User } from '../src/db/models.js';
import { closeQueues, drainAll } from '../src/pipeline/queue.js';

const PASSWORD = 'correct-horse-battery';
let admin: ReturnType<typeof request.agent>;
let reviewer: ReturnType<typeof request.agent>;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await User.create([
    { email: 'admin@example.com', role: 'admin', passwordHash },
    { email: 'reviewer@example.com', role: 'reviewer', passwordHash },
  ]);
  admin = request.agent(app);
  reviewer = request.agent(app);
  await admin.post('/auth/login').send({ email: 'admin@example.com', password: PASSWORD }).expect(200);
  await reviewer.post('/auth/login').send({ email: 'reviewer@example.com', password: PASSWORD }).expect(200);
});

afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('auth', () => {
  it('rejects a wrong password with the contract error shape', async () => {
    const r = await request(app).post('/auth/login').send({ email: 'admin@example.com', password: 'nope' });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: 'unauthorized', message: 'Wrong email or password' } });
  });

  it('sets an httpOnly cookie and never returns the password hash', async () => {
    const r = await request(app).post('/auth/login').send({ email: 'ADMIN@example.com', password: PASSWORD });
    expect(r.headers['set-cookie'][0]).toMatch(/^sid=.*HttpOnly.*SameSite=Lax/);
    expect(JSON.stringify(r.body)).not.toContain('passwordHash');
    const me = await admin.get('/auth/me');
    expect(me.body).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(JSON.stringify((await admin.get('/users')).body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('needs a login for protected routes, and admin for admin routes', async () => {
    expect((await request(app).get('/companies')).status).toBe(401);
    expect((await reviewer.get('/users')).status).toBe(403);
    expect((await reviewer.post('/runs').send({ edition: 2026 })).status).toBe(403);
  });

  it('rate-limits repeated failed logins', async () => {
    const email = 'victim@example.com';
    for (let i = 0; i < 10; i++) await request(app).post('/auth/login').send({ email, password: 'x' });
    const r = await request(app).post('/auth/login').send({ email, password: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
  });

  it('logs out', async () => {
    const a = request.agent(app);
    await a.post('/auth/login').send({ email: 'reviewer@example.com', password: PASSWORD });
    await a.post('/auth/logout').expect(204);
    expect((await a.get('/auth/me')).status).toBe(401);
  });
});

describe('errors', () => {
  it('unknown route → 404 not_found', async () => {
    const r = await admin.get('/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
  it('bad input → 400 with details', async () => {
    const r = await admin.post('/events').send({ edition: 'soon' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
    expect(r.body.error.details).toBeDefined();
  });
  it('bad id → 400, missing id → 404', async () => {
    expect((await admin.get('/companies/not-an-id')).status).toBe(400);
    expect((await admin.get('/companies/64b000000000000000000000')).status).toBe(404);
  });
});

describe('users', () => {
  it('admin can create, update and delete users, but not the last admin', async () => {
    const created = await admin.post('/users').send({ email: 'new@example.com', password: 'long-enough-pw', role: 'reviewer' }).expect(201);
    await admin.patch(`/users/${created.body.id}`).send({ role: 'admin' }).expect(200);
    await admin.delete(`/users/${created.body.id}`).expect(204);
    const me = await admin.get('/auth/me');
    expect((await admin.delete(`/users/${me.body.id}`)).status).toBe(400);
    expect((await admin.patch(`/users/${me.body.id}`).send({ role: 'reviewer' })).status).toBe(400);
  });
});

describe('events, runs, companies, overview', () => {
  beforeAll(async () => {
    await admin
      .post('/events')
      .send({ edition: 2026, name: 'ADIPEC 2026', directoryUrl: 'https://www.adipec.com/exhibition/exhibitor-list/' })
      .expect(201);
    await Company.create(
      ['Alpha Drilling', 'Beta Subsea', 'Gamma Valves'].map((name, i) => ({
        name,
        normalizedName: name.toLowerCase(),
        domain: `${name.split(' ')[0].toLowerCase()}.example.com`,
        editions: [
          { edition: 2026, sourceId: String(i), country: i ? 'Norway' : 'United Arab Emirates', category: 'O&G', capturedAt: new Date() },
        ],
        stages: { profile: { status: i === 2 ? ('failed' as const) : ('completed' as const) } },
        contactsCount: i,
        completeness: i * 10,
      })),
    );
  });

  it('rejects a duplicate edition', async () => {
    expect((await admin.post('/events').send({ edition: 2026, name: 'x', directoryUrl: 'https://x.example.com' })).status).toBe(409);
  });

  it('lists events without the internal category map', async () => {
    const r = await reviewer.get('/events').expect(200);
    expect(r.body[0]).toEqual({ id: expect.any(String), edition: 2026, name: 'ADIPEC 2026', directoryUrl: expect.any(String) });
  });

  it('filters, sorts and pages companies', async () => {
    const all = await reviewer.get('/companies').expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 50, total: 3 });
    expect((await reviewer.get('/companies?country=norway')).body.total).toBe(2);
    expect((await reviewer.get('/companies?q=BETA')).body.items[0].name).toBe('Beta Subsea');
    expect((await reviewer.get('/companies?q=gamma.example')).body.total).toBe(1);
    expect((await reviewer.get('/companies?step=profile&stepStatus=failed')).body.total).toBe(1);
    expect((await reviewer.get('/companies?hasContacts=false')).body.total).toBe(1);
    expect((await reviewer.get('/companies?sort=-completeness')).body.items[0].name).toBe('Gamma Valves');
    expect((await reviewer.get('/companies?pageSize=2&page=2')).body.items).toHaveLength(1);
    expect((await reviewer.get('/companies?pageSize=500')).status).toBe(400);
    expect((await reviewer.get('/companies?q=(')).status).toBe(200); // regex characters are escaped
  });

  it('returns a full company', async () => {
    const id = (await reviewer.get('/companies?q=alpha')).body.items[0].id;
    const r = await reviewer.get(`/companies/${id}`).expect(200);
    expect(r.body).toMatchObject({ name: 'Alpha Drilling', domain: 'alpha.example.com', contacts: [], leadershipCoverage: 'unknown' });
    expect(r.body.editions[0]).toMatchObject({ edition: 2026, country: 'United Arab Emirates' });
  });

  it('gives an overview with advertised and discovered kept apart', async () => {
    await Event.updateOne({ edition: 2026 }, { advertisedCount: 2260 });
    const r = await reviewer.get('/stats/overview').expect(200);
    expect(r.body).toMatchObject({ edition: 2026, advertised: 2260, discovered: 3, unique: 3, duplicates: 0, failures: 1 });
    expect(r.body.byStep.profile).toEqual({ completed: 2, failed: 1 });
    expect(r.body.emailsByStatus).toEqual({ verified: 0, invalid: 0, risky: 0, unknown: 0, not_checked: 0 });
  });

  it('starts, refuses a second, pauses and resumes a run', async () => {
    const started = await admin
      .post('/runs')
      .send({ edition: 2026, steps: ['directory', 'profile'] })
      .expect(202);
    expect(started.body).toMatchObject({ status: 'running', steps: ['directory', 'profile'], startedBy: 'admin@example.com' });
    expect(started.body.perStep.directory).toEqual({ queued: 1, done: 0, failed: 0 });

    expect((await admin.post('/runs').send({ edition: 2026 })).status).toBe(409);
    expect((await admin.post(`/runs/${started.body.id}/pause`)).body.status).toBe('paused');
    expect((await admin.post(`/runs/${started.body.id}/pause`)).status).toBe(409);
    expect((await admin.post(`/runs/${started.body.id}/resume`)).body.status).toBe('running');
    expect((await reviewer.get('/runs')).body.total).toBe(1);
    await Run.updateOne({ _id: started.body.id }, { status: 'completed' });
  });

  it('refuses a run for an unknown edition', async () => {
    expect((await admin.post('/runs').send({ edition: 1999 })).status).toBe(404);
  });
});

describe('system', () => {
  it('health reports mongo and redis', async () => {
    const r = await request(app).get('/health');
    expect(r.body).toMatchObject({ ok: true, mongo: true, redis: true });
  });
  it('cron needs the secret', async () => {
    expect((await request(app).post('/cron/anything')).status).toBe(401);
    expect((await request(app).post('/cron/anything').set('x-cron-secret', 'test-cron-secret-123')).status).toBe(404);
  });
});
