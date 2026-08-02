import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

type Surface = {
  name: string;
  path: string;
  testId: string;
  viewport: { width: number; height: number };
};

const surfaces: Surface[] = [
  {
    name: 'hq-desktop',
    path: '/hq/orders?role=hq&view=orders&demo=1',
    testId: 'hq-order-screen',
    viewport: { width: 1440, height: 1000 }
  },
  {
    name: 'store-mobile',
    path: '/store/orders?role=store&view=orders&demo=1',
    testId: 'store-order-screen',
    viewport: { width: 360, height: 800 }
  },
  {
    name: 'driver-mobile',
    path: '/driver/today?role=driver&view=today&demo=1',
    testId: 'driver-today-screen',
    viewport: { width: 360, height: 800 }
  }
];

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth
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

async function saveReviewScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const surface of surfaces) {
  test(`${surface.name} is usable, accessible and reviewable`, async ({ page }, testInfo) => {
    await page.setViewportSize(surface.viewport);
    await page.goto(surface.path, { waitUntil: 'networkidle' });

    await expect(page.getByTestId(surface.testId)).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByText('데모 데이터', { exact: false }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press('Tab');
    const focusIsVisible = await page.evaluate(() => document.activeElement !== document.body);
    expect(focusIsVisible).toBe(true);

    await expectWcagAa(page);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await saveReviewScreenshot(page, testInfo, surface.name);
  });
}
