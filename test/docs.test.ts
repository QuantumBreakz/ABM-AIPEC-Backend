import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

describe('Swagger /docs endpoint', () => {
  it('serves Swagger UI HTML at /docs/', async () => {
    const res = await request(app).get('/docs/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger-ui');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('serves full OpenAPI 3.0.3 spec at /docs/openapi.json covering all endpoints', async () => {
    const res = await request(app).get('/docs/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths).toBeDefined();

    const expectedPaths = [
      '/health',
      '/cron/{task}',
      '/auth/login',
      '/auth/logout',
      '/auth/me',
      '/users',
      '/users/{id}',
      '/events',
      '/runs',
      '/runs/{id}',
      '/runs/{id}/companies',
      '/runs/{id}/pause',
      '/runs/{id}/resume',
      '/companies',
      '/companies/{id}',
      '/companies/{id}/steps/{step}',
      '/companies/{id}/merge',
      '/companies/{id}/not-duplicate',
      '/companies/{id}/history',
      '/companies/{id}/contacts',
      '/companies/{id}/contacts/import',
      '/contacts/{id}',
      '/companies/{id}/ai/regenerate',
      '/companies/{id}/ai',
      '/contacts/{id}/ai/regenerate',
      '/contacts/{id}/ai',
      '/review/counts',
      '/review',
      '/exports/log',
      '/exports/{kind}/count',
      '/exports/{file}',
      '/verification/run',
      '/settings/providers',
      '/suppressions',
      '/suppressions/{id}',
      '/stats/overview',
      '/reports/gap',
      '/reports/gap.csv',
    ];
    for (const p of expectedPaths) {
      expect(res.body.paths[p], `Missing path ${p} in OpenAPI spec`).toBeDefined();
    }
  });
});
