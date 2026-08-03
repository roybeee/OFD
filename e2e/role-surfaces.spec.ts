import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { prepareStoreSession, prepareSubmittedOrderForHq } from './real-fixture';

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(dimensions.page, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectWcagAa(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = violations.filter(({ impact }) => impact === 'critical' || impact === 'serious');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectReadableDesktopType(page: Page) {
  const result = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const px = (selector: string) => Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    return {
      supporting: px('main p, main small, main label, main th, main td, main .status-badge'),
      controls: px('.primary-nav button, main button, main input, main textarea'),
    };
  });
  expect(Math.min(...result.supporting), JSON.stringify(result)).toBeGreaterThanOrEqual(12);
  expect(Math.min(...result.controls), JSON.stringify(result)).toBeGreaterThanOrEqual(13);
}

async function saveReviewScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('본사 주문 화면은 실제 주문·큰 글씨·워크스테이션 복귀 동선을 제공한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await prepareSubmittedOrderForHq(page);
  await page.goto('/v2/hq/orders', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('hq-order-screen')).toBeVisible();
  await expect(page.getByText('데모 데이터', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /워크스테이션 홈/ })).toHaveAttribute('href', '/');
  const createdOrder = page.getByRole('table', { name: '주문 검토 목록' }).getByRole('row').filter({ hasText: fixture.orderNumber });
  await expect(createdOrder).toHaveCount(1);
  await expectReadableDesktopType(page);
  await expectNoHorizontalOverflow(page);
  await expectWcagAa(page);
  await saveReviewScreenshot(page, testInfo, 'hq-orders-live-desktop');
});

test('점주 발주 화면은 실제 매장 세션으로 모바일에서도 사용할 수 있다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareStoreSession(page);
  await page.goto('/v2/store/orders', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('store-order-screen')).toBeVisible();
  await expect(page.getByText('데모 데이터', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /워크스테이션 홈/ })).toHaveAttribute('href', '/');
  await expectNoHorizontalOverflow(page);
  await expectWcagAa(page);
  await saveReviewScreenshot(page, testInfo, 'store-orders-live-mobile');
});
