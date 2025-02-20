import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from '@utils/test/playwright';

test.describe('tab-button: a11y', () => {
  test('should not have any axe violations', async ({ page }) => {
    await page.goto('/src/components/tab-button/test/a11y');

    // TODO FW-3604
    const results = await new AxeBuilder({ page }).disableRules('color-contrast').analyze();
    expect(results.violations).toEqual([]);
  });
});
