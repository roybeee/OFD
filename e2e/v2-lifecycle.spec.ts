import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  DRIVER_ID,
  WEBHOOK_KEY,
  bootstrap,
  forceOrderToOperationalDate,
  injectBankTransaction,
  listAggregates,
  login,
  mutate,
  operationalDateKst,
  requireOk,
  waitForAggregate,
} from './real-fixture';

type OrderResponse = { order: { id: string; number: string; status: string; version: number; gross: number; storeId: string } };
type ShipmentResponse = { shipment: { id: string; status: string; version: number } };
type DeliveryResponse = { shipment: { id: string; status: string; version: number }; receipt: { id: string; status: string } };
type SettlementResponse = { settlement: { id: string; status: string; version: number; gross: number }; paymentRequest: { id: string; status: string; version: number; amount: number } };
type InvoiceResponse = { invoice: { id: string; status: string; version: number; providerManagementKey: string } };

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = violations.filter(({ impact }) => impact === 'critical' || impact === 'serious');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(sizes.page, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function expectMobileReadability(page: Page) {
  const sizes = await page.evaluate(() => {
    const px = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
    };
    return {
      heading: px('.page-heading h1, .driver-greeting h1'),
      metricLabel: px('.metric-card p'),
      metricValue: px('.metric-card strong'),
      metricDetail: px('.metric-card small'),
      sectionTitle: px('.panel-heading h2, .queue-toolbar h2'),
    };
  });
  expect(sizes.heading).toBeGreaterThanOrEqual(30);
  expect(sizes.metricLabel).toBeGreaterThanOrEqual(14);
  expect(sizes.metricValue).toBeGreaterThanOrEqual(22);
  expect(sizes.metricDetail).toBeGreaterThanOrEqual(13);
  expect(sizes.sectionTitle).toBeGreaterThanOrEqual(20);
}

test.describe.serial('real V2 order-to-tax-invoice lifecycle', () => {
  test('store → HQ → driver → finance → master → worker → store documents', async ({ page }, testInfo) => {
    const health = await requireOk<{ ok: boolean; mode: string }>(await page.request.get('/api/v2/health'), 'health');
    expect(health).toMatchObject({ ok: true, mode: 'test' });
    const ready = await requireOk<{ ok: boolean; components: { database: { mode: string }; worker: { ok: boolean } } }>(
      await page.request.get('/api/v2/ready'), 'readiness');
    expect(ready.ok).toBe(true);
    expect(ready.components.database.mode).toBe('postgres');
    expect(ready.components.worker.ok).toBe(true);
    expect((await page.request.get('/api/v2/bootstrap')).status()).toBe(401);

    await login(page, 'store', true);
    await expect(page.getByTestId('store-order-screen')).toBeVisible();
    await page.getByRole('button', { name: /새 발주 시작/ }).click();
    const wizard = page.getByRole('dialog');
    await wizard.getByRole('button', { name: /한 박스 추가/ }).first().click();
    await wizard.getByRole('button', { name: /다음 단계/ }).click();
    await wizard.getByRole('button', { name: /다음 단계/ }).click();
    await wizard.getByRole('checkbox').check();
    const submittedResponse = page.waitForResponse((response) => response.url().endsWith('/api/v2/orders/submit-new') && response.request().method() === 'POST');
    await wizard.getByRole('button', { name: '발주 제출하기' }).click();
    const submitted = await requireOk<OrderResponse>(await submittedResponse, 'store order submit');
    expect(submitted.order.status).toBe('submitted');
    await screenshot(page, testInfo, '01-store-order-submitted');

    const today = await forceOrderToOperationalDate(submitted.order.id);
    expect(today).toBe(operationalDateKst());

    await login(page, 'ops');
    await page.goto('/hq/orders', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('hq-order-screen')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: submitted.order.number })).toHaveCount(1);
    const approved = await mutate<OrderResponse>(page, `/orders/${submitted.order.id}/approve`,
      { expectedVersion: submitted.order.version }, 'HQ order approval');
    expect(approved.order.status).toBe('approved');
    const assigned = await mutate<ShipmentResponse>(page, '/shipments', {
      orderId: submitted.order.id,
      driverId: DRIVER_ID,
      plannedDate: today,
      routeSequence: 1,
      deliveryWindow: { start: '09:00', end: '10:00' },
    }, 'HQ shipment assignment');
    const dispatched = await mutate<ShipmentResponse>(page, `/shipments/${assigned.shipment.id}/dispatch`,
      { expectedVersion: assigned.shipment.version }, 'HQ shipment dispatch');
    expect(dispatched.shipment.status).toBe('out_for_delivery');
    await page.goto('/hq/delivery', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('hq-delivery-screen')).toContainText('독산점');
    await screenshot(page, testInfo, '02-hq-approved-and-dispatched');

    await login(page, 'driver', true);
    await expect(page.getByTestId('driver-today-screen')).toContainText('독산점');
    await page.getByRole('button', { name: '배송 상세' }).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByTestId('delivery-proof-input').setInputFiles({
      name: 'e2e-proof.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl9sAAAAASUVORK5CYII=', 'base64'),
    });
    await drawer.getByPlaceholder('예: 김점주').fill('박독산');
    const deliveryResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v2/shipments/${assigned.shipment.id}/deliver`));
    await drawer.getByTestId('delivery-complete-button').click();
    const delivered = await requireOk<DeliveryResponse>(await deliveryResponse, 'driver delivery completion');
    expect(delivered).toMatchObject({ shipment: { status: 'delivered' }, receipt: { status: 'confirmed' } });
    await expect(page.getByText(/배송 완료와 수취 증빙이 저장되었습니다/)).toBeVisible();
    await screenshot(page, testInfo, '03-driver-proof-delivered');

    await login(page, 'finance');
    const drafted = await mutate<SettlementResponse>(page, '/settlements', {
      storeId: submitted.order.storeId,
      periodStart: today,
      periodEnd: today,
      receiptIds: [delivered.receipt.id],
    }, 'finance settlement draft');
    expect(drafted.settlement.status).toBe('draft');
    expect(drafted.paymentRequest).toMatchObject({ status: 'pending', amount: drafted.settlement.gross });
    const bank = await injectBankTransaction(drafted.paymentRequest.amount, '박독산');
    const matched = await mutate<{ paid: Array<{ id: string }>; manualReview: unknown[] }>(page, '/payments/auto-match', {}, 'finance auto-match');
    expect(matched.paid.map(({ id }) => id)).toContain(drafted.paymentRequest.id);
    const reviewedSettlement = await mutate<SettlementResponse>(page, `/settlements/${drafted.settlement.id}/review`,
      { expectedVersion: drafted.settlement.version }, 'finance settlement review');
    expect(reviewedSettlement.settlement.status).toBe('reviewed');
    const matchedBank = await waitForAggregate<{ matched: boolean }>('bank_transaction', bank.id, (value) => value.matched === true);
    expect(matchedBank.matched).toBe(true);
    await page.goto('/hq/invoices', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('hq-invoice-screen')).toContainText('독산점');
    await screenshot(page, testInfo, '04-finance-payment-and-settlement-review');

    await login(page, 'master');
    const approvedSettlement = await mutate<SettlementResponse>(page, `/settlements/${drafted.settlement.id}/approve`,
      { expectedVersion: reviewedSettlement.settlement.version }, 'master settlement approval');
    expect(approvedSettlement.settlement.status).toBe('approved');

    await login(page, 'finance');
    const invoiceDraft = await mutate<InvoiceResponse>(page, '/invoices',
      { settlementId: drafted.settlement.id }, 'finance invoice draft');
    expect(invoiceDraft.invoice.status).toBe('draft');
    const invoiceReviewed = await mutate<InvoiceResponse>(page, `/invoices/${invoiceDraft.invoice.id}/review`,
      { expectedVersion: invoiceDraft.invoice.version }, 'finance invoice review');
    expect(invoiceReviewed.invoice.status).toBe('reviewed');

    await login(page, 'master');
    const invoiceApproved = await mutate<InvoiceResponse>(page, `/invoices/${invoiceDraft.invoice.id}/approve`,
      { expectedVersion: invoiceReviewed.invoice.version }, 'master invoice approval');
    expect(invoiceApproved.invoice.status).toBe('approved');
    const issued = await waitForAggregate<{ status: string; providerReceiptId?: string; providerManagementKey: string }>(
      'tax_invoice', invoiceDraft.invoice.id, (value) => value.status === 'nts_pending' && Boolean(value.providerReceiptId));

    const webhook = await page.request.post('/api/v2/webhooks/popbill', {
      headers: {
        'X-Api-Key': WEBHOOK_KEY,
        'Pb-Webhook-MID': 'e2e-popbill-final-001',
        'Pb-Webhook-CorpNum': '1234567890',
      },
      data: {
        corpNum: '1234567890',
        stateCode: 304,
        itemKey: issued.providerReceiptId,
        invoicerMgtKey: issued.providerManagementKey,
        ntsconfirmNum: '123456789012345678901234',
      },
    });
    expect(webhook.status()).toBe(202);
    const finalInvoice = await waitForAggregate<{ status: string }>('tax_invoice', invoiceDraft.invoice.id,
      (value) => value.status === 'nts_success', 20_000);
    expect(finalInvoice.status).toBe('nts_success');
    const locked = await waitForAggregate<{ status: string }>('settlement', drafted.settlement.id, (value) => value.status === 'locked');
    expect(locked.status).toBe('locked');
    await expect.poll(async () => {
      const documents = await listAggregates<{ id: string; aggregateId: string; kind: string }>('document');
      return documents.some((document) => document.aggregateId === invoiceDraft.invoice.id && document.kind === 'tax_invoice');
    }, {
      timeout: 20_000,
    }).toBe(true);

    await login(page, 'store');
    await page.goto('/store/documents', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('store-document-screen')).toContainText('전자세금계산서');
    const storeBootstrap = await bootstrap<{ documents: Array<{ id: string; aggregateId: string; objectKey?: string }> }>(page);
    const invoiceDocument = storeBootstrap.documents.find((document) => document.aggregateId === invoiceDraft.invoice.id);
    expect(invoiceDocument).toBeTruthy();
    expect(invoiceDocument).not.toHaveProperty('objectKey');
    const download = await requireOk<{ downloadUrl: string; expiresInSeconds: number; document: { id: string; objectKey?: string } }>(
      await page.request.get(`/api/v2/documents/${invoiceDocument!.id}/download`), 'store signed document download');
    expect(download.downloadUrl).toContain('/api/v2/mock-files?');
    expect(download.expiresInSeconds).toBe(900);
    expect(download.document).not.toHaveProperty('objectKey');
    expect((await page.request.get(download.downloadUrl)).status()).toBe(200);
    await screenshot(page, testInfo, '05-store-final-documents');
  });

  test('role boundaries, mobile layout, and WCAG checks remain intact', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'store');
    await page.goto('/hq/invoices', { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/store\/orders$/);
    await expect(page.getByTestId('store-order-screen')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMobileReadability(page);
    await expectAccessible(page);
    await screenshot(page, testInfo, '06-store-mobile-role-boundary');

    await login(page, 'driver');
    await page.goto('/hq/reconciliation', { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/driver\/today$/);
    await expect(page.getByTestId('driver-today-screen')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMobileReadability(page);
    await expectAccessible(page);

    await login(page, 'ops');
    await page.goto('/hq/orders', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('hq-order-screen')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectMobileReadability(page);
    await expectAccessible(page);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, 'finance');
    await page.goto('/hq/delivery', { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/hq\/reconciliation$/);
    await expect(page.getByTestId('hq-reconciliation-screen')).toBeVisible();

    await login(page, 'ops');
    await page.goto('/hq/invoices', { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/hq\/orders$/);
    await expect(page.getByTestId('hq-order-screen')).toBeVisible();

    await login(page, 'master');
    await page.goto('/hq/accounts', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: '계정 관리', level: 1 })).toBeVisible();
    await expectAccessible(page);
  });
});
