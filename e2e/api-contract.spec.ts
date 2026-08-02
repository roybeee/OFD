import { expect, test } from '@playwright/test';

const apiBase = process.env.E2E_API_BASE ?? 'http://127.0.0.1:4100';

test('demo API exposes health without provider side effects', async ({ request }) => {
  const response = await request.get(`${apiBase}/api/v2/health`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toMatchObject({
    ok: true,
    mode: 'demo',
    providerMode: 'mock'
  });
});

test('demo bootstrap is available to the seeded store actor', async ({ request }) => {
  const response = await request.get(`${apiBase}/api/v2/bootstrap`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const body = await response.json();
  expect(body).toBeTruthy();
  expect(typeof body).toBe('object');
  expect(body.error).toBeUndefined();
});
