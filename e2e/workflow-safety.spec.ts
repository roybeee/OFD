import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

async function openDemo(page: Page, path: string, testId: string) {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo=1`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId(testId)).toBeVisible();
}

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
  testInfo,
  screenshotName
}: {
  page: Page;
  trigger: Locator;
  closeName: string;
  lastActionName: RegExp;
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

test('role switching requires an explicit demo opt-in', async ({ page }) => {
  await openDemo(page, '/store/orders?role=store&view=orders', 'store-order-screen');
  const switcher = page.getByRole('group', { name: '화면 역할 전환' });
  await expect(switcher).toBeVisible();
  await switcher.getByRole('button', { name: '본사 운영 화면' }).click();
  await expect(page.getByTestId('hq-order-screen')).toBeVisible();

  await page.goto('/store/orders', { waitUntil: 'networkidle' });
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByRole('group', { name: '화면 역할 전환' })).toHaveCount(0);
});

test('store order dialog traps focus, closes with Escape and restores its trigger', async ({ page }, testInfo) => {
  await openDemo(page, '/store/orders?role=store&view=orders', 'store-order-screen');
  await expectDialogKeyboardSafety({
    page,
    trigger: page.getByRole('button', { name: /새 발주 시작/ }),
    closeName: '발주 창 닫기',
    lastActionName: /다음 단계/,
    testInfo,
    screenshotName: 'store-order-dialog-open'
  });
});

test('HQ order drawer traps focus, closes with Escape and restores its row', async ({ page }, testInfo) => {
  await openDemo(page, '/hq/orders?role=hq&view=orders', 'hq-order-screen');
  const trigger = page.getByRole('table', { name: '주문 검토 목록' }).getByRole('row').nth(1);
  await expectDialogKeyboardSafety({
    page,
    trigger,
    closeName: '주문 상세 닫기',
    lastActionName: /승인하고 배송 준비/,
    testInfo,
    screenshotName: 'hq-order-review-drawer-open'
  });
});

test('ambiguous deposits cannot be manually linked without selecting a claim', async ({ page }) => {
  await openDemo(page, '/hq/reconciliation?role=hq&view=reconciliation', 'hq-reconciliation-screen');
  await expect(page.getByText('일치 후보 2건')).toBeVisible();
  const blockedActions = page.getByRole('button', { name: '청구 선택 필요' });
  expect(await blockedActions.count()).toBeGreaterThan(0);
  for (let index = 0; index < await blockedActions.count(); index += 1) {
    await expect(blockedActions.nth(index)).toBeDisabled();
  }
});

test('mobile delivery proof drawer contains overflow and rejects unsafe files', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openDemo(page, '/driver/today?role=driver&view=today', 'driver-today-screen');
  await page.locator('.driver-next').getByRole('button', { name: '배송 상세' }).click();

  const dialog = page.getByRole('dialog');
  const fileInput = dialog.locator('input[type="file"]');
  const complete = dialog.getByRole('button', { name: '배송 완료 처리' });
  await expect(dialog).toBeVisible();

  const dimensions = await page.evaluate(() => {
    const openedDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const bounds = openedDialog?.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      dialogLeft: bounds?.left ?? -1,
      dialogRight: bounds?.right ?? Number.POSITIVE_INFINITY,
      dialogScrollWidth: openedDialog?.scrollWidth ?? Number.POSITIVE_INFINITY,
      dialogClientWidth: openedDialog?.clientWidth ?? 0
    };
  });
  expect(dimensions.pageWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.dialogLeft, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(-1);
  expect(dimensions.dialogRight, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.dialogScrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.dialogClientWidth + 1);

  await fileInput.setInputFiles({
    name: 'proof.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image')
  });
  await expect(page.getByText('JPG, PNG, WEBP 사진만 올릴 수 있어요')).toBeVisible();
  await expect(complete).toBeDisabled();

  await fileInput.setInputFiles({
    name: 'proof-too-large.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1)
  });
  await expect(page.getByText('사진은 10MB 이하만 올릴 수 있어요')).toBeVisible();
  await expect(complete).toBeDisabled();

  await fileInput.setInputFiles({
    name: 'proof-safe.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  });
  await expect(dialog.getByText('proof-safe.jpg')).toBeVisible();
  await expect(complete).toBeEnabled();
  await attachScreenshot(page, testInfo, 'driver-proof-drawer-open-mobile');
});
