import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { prepareStoreSession, prepareSubmittedOrderForHq } from './real-fixture';

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function expectDialogKeyboardSafety({
  page,
  trigger,
  closeName,
  lastActionName,
  afterOpen,
  testInfo,
  screenshotName,
}: {
  page: Page;
  trigger: Locator;
  closeName: string;
  lastActionName: RegExp;
  afterOpen?: (dialog: Locator) => Promise<void>;
  testInfo: TestInfo;
  screenshotName: string;
}) {
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: closeName });
  const lastAction = dialog.getByRole('button', { name: lastActionName });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  if (afterOpen) await afterOpen(dialog);

  await lastAction.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(lastAction).toBeFocused();

  await attachScreenshot(page, testInfo, screenshotName);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
}

test('실제 점주 발주 창은 빈 수량으로 열리고 키보드 초점을 안전하게 가둔다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareStoreSession(page);
  await page.goto('/v2/store/orders', { waitUntil: 'networkidle' });
  const trigger = page.getByRole('button', { name: /새 발주 시작/ });
  await expectDialogKeyboardSafety({
    page,
    trigger,
    closeName: '발주 창 닫기',
    lastActionName: /다음 단계/,
    afterOpen: async (dialog) => {
      const quantities = dialog.locator('.quantity-control output');
      await expect(quantities.first()).toBeVisible();
      const quantityTexts = await quantities.allTextContents();
      expect(quantityTexts.length).toBeGreaterThan(0);
      expect(quantityTexts.every((value) => value.trim() === '0')).toBe(true);
      await expect(dialog.locator('.wizard-footer').getByText('0박스', { exact: true })).toBeVisible();
      const next = dialog.getByRole('button', { name: /다음 단계/ });
      await expect(next).toBeDisabled();
      await dialog.getByRole('button', { name: /한 박스 추가/ }).first().click();
      await expect(next).toBeEnabled();
    },
    testInfo,
    screenshotName: 'store-order-dialog-live',
  });
});

test('실제 본사 주문 검토 drawer는 Escape와 초점 복원을 지원한다', async ({ page }, testInfo) => {
  const fixture = await prepareSubmittedOrderForHq(page);
  await page.goto('/v2/hq/orders', { waitUntil: 'networkidle' });
  const trigger = page.getByRole('table', { name: '주문 검토 목록' }).getByRole('row').filter({ hasText: fixture.orderNumber });
  await expectDialogKeyboardSafety({
    page,
    trigger,
    closeName: '주문 상세 닫기',
    lastActionName: /발주 승인/,
    testInfo,
    screenshotName: 'hq-order-review-drawer-live',
  });
});

test('통합 발주 화면에서 기존 워크스테이션으로 돌아갈 수 있다', async ({ page }) => {
  await prepareStoreSession(page);
  await page.goto('/v2/store/orders', { waitUntil: 'networkidle' });
  const home = page.getByRole('link', { name: /워크스테이션 홈/ });
  await expect(home).toBeVisible();
  await home.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#app')).toBeVisible();
});

test('기존 본사 워크스테이션과 통합 발주정산을 같은 탭에서 왕복한다', async ({ page }) => {
  await prepareSubmittedOrderForHq(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  const entry = page.getByRole('link', { name: '통합 발주·정산 메뉴' });
  await expect(entry).toBeVisible();
  await expect(entry).not.toHaveAttribute('target');
  await entry.click();
  await expect(page).toHaveURL(/\/v2\/hq\/orders$/);

  await page.getByRole('link', { name: /워크스테이션 홈/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#app')).toBeVisible();
});
