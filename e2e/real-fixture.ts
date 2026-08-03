import type { Page } from '@playwright/test';

const EXTERNAL_RUN = Boolean(process.env.E2E_BASE_URL || process.env.E2E_API_BASE);
const API_BASE = process.env.E2E_API_BASE ?? process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4100';
const MASTER = EXTERNAL_RUN
  ? { username: process.env.E2E_HQ_USERNAME ?? '', password: process.env.E2E_HQ_PASSWORD ?? '' }
  : { username: 'e2emaster', password: 'e2e-master-2468' };
let qaGuardVerified = false;

async function post(page: Page, path: string, data: Record<string, unknown>, headers: Record<string, string> = {}) {
  return page.request.post(`${API_BASE}${path}`, {
    data,
    headers: { 'X-OFD': '1', ...headers },
  });
}

async function requireOk(response: Awaited<ReturnType<typeof post>>, label: string) {
  if (!response.ok()) throw new Error(`${label} failed (${response.status()}): ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function ensureHqSession(page: Page) {
  if (EXTERNAL_RUN && !qaGuardVerified) {
    const guard = await page.request.get(`${API_BASE}/api/e2e/qa-guard`, {
      headers: { 'X-OFD-E2E-Token': process.env.E2E_QA_TOKEN ?? '' },
    });
    const guardBody = await guard.json().catch(() => ({})) as { ok?: boolean; environment?: string };
    if (!guard.ok() || guardBody.ok !== true || guardBody.environment !== 'qa') {
      throw new Error(`External target did not confirm isolated QA mode (${guard.status()}).`);
    }
    qaGuardVerified = true;
  }
  const state = await page.request.get(`${API_BASE}/api/state`);
  const body = await state.json() as { setup?: boolean };
  if (body.setup) {
    if (EXTERNAL_RUN) throw new Error('External QA is not initialized. Provision a dedicated HQ test account before running E2E.');
    await requireOk(await post(page, '/api/setup', {
      ...MASTER,
      name: 'E2E 운영 마스터',
    }), 'setup');
    return;
  }
  await requireOk(await post(page, '/api/auth/hq', MASTER), 'HQ login');
}

function unique(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function prepareStoreSession(page: Page) {
  await ensureHqSession(page);
  const suffix = unique('qa');
  const store = await requireOk(await post(page, '/api/stores', {
    name: `화면검증 ${suffix}`,
    type: '가맹',
    region: '서울',
    addr: '서울특별시 테스트로 10',
    phone: '02-1234-5678',
  }), 'store create');
  const product = await requireOk(await post(page, '/api/skus', {
    name: `화면검증 상품 ${suffix}`,
    price: 28_600,
    supply: 26_000,
    category: '기타',
  }), 'product create');

  await requireOk(await post(page, '/api/auth/store', {
    storeId: store.id,
    code: store.code,
  }), 'store login');

  return { storeId: String(store.id), productId: String(product.skuId) };
}

export async function prepareSubmittedOrderForHq(page: Page) {
  const fixture = await prepareStoreSession(page);
  const bootstrap = await page.request.get(`${API_BASE}/api/v2/bootstrap`);
  if (!bootstrap.ok()) throw new Error(`store bootstrap failed (${bootstrap.status()}): ${await bootstrap.text()}`);
  const data = await bootstrap.json() as { allowedDeliveryDates?: string[] };
  const deliveryDate = data.allowedDeliveryDates?.[0];
  if (!deliveryDate) throw new Error('No real delivery date was returned');

  const submitted = await requireOk(await post(page, '/api/v2/orders/submit-new', {
    storeId: fixture.storeId,
    requestedDeliveryDate: deliveryDate,
    items: [{ productId: fixture.productId, quantity: 2 }],
  }, { 'Idempotency-Key': unique('e2e-order') }), 'V2 order submit');
  await ensureHqSession(page);
  const order = submitted.order as { id?: unknown; number?: unknown } | undefined;
  if (!order?.id || !order.number) throw new Error('Submitted order response is missing its identity');
  return { ...fixture, orderId: String(order.id), orderNumber: String(order.number) };
}

export { API_BASE };
