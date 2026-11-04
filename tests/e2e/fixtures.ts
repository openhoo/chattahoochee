import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ guardBrowser: void }>({
  guardBrowser: [async ({ page, context }, use) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:1430') {
        external.push(url.origin); return route.abort();
      }
      return route.continue();
    });
    await use();
    expect(external, 'The demo/browser UI must never contact an enterprise service').toEqual([]);
    expect(errors, 'No browser errors, React warnings or unhandled rejections').toEqual([]);
  }, { auto: true }],
});
export { expect };
export const list = (page: Page) => page.getByLabel('Conversation list', { exact: true });
export const composer = (page: Page) => page.getByRole('textbox', { name: 'Write a demo message', exact: true });
export const transcript = (page: Page) => page.locator('.transcript-content');
export async function demo(page: Page) {
  await page.goto('/?demo=1');
  await expect(list(page).getByRole('button')).toHaveCount(6);
  await expect(composer(page)).toBeVisible();
}
export async function details(page: Page) {
  const toggle = page.getByRole('button', { name: 'Show conversation details', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  return page.getByLabel('Conversation details', { exact: true });
}
export async function accountForm(page: Page) {
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  return dialog;
}
