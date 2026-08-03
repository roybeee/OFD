import { expect, test } from '@playwright/test';
import { API_BASE, ensureHqSession } from './real-fixture';

test('SQLite 운영 서버가 health를 제공한다', async ({ request }) => {
  const response = await request.get(`${API_BASE}/health`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toMatchObject({ ok: true });
});

test('인증 없는 V2 bootstrap은 실제 데이터 대신 401을 반환한다', async ({ request }) => {
  const response = await request.get(`${API_BASE}/api/v2/bootstrap`);
  expect(response.status()).toBe(401);
});

test('실제 OFD 세션으로 production bootstrap을 읽는다', async ({ page }) => {
  await ensureHqSession(page);
  const response = await page.request.get(`${API_BASE}/api/v2/bootstrap`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.meta).toMatchObject({ appMode: 'production', apiVersion: 'v2-sqlite' });
  expect(body.currentActor).toMatchObject({ role: 'hq_master' });
  expect(body.availableActors).toEqual([]);
});
