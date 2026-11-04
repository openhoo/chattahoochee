import { test, expect, accountForm } from './fixtures';

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('live browser starts with no accounts or synthetic messages', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A fresh start', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect your first account', exact: true })).toBeVisible();
  await expect(page.getByText('Demo workspace', { exact: true })).toHaveCount(0);
  await expect(page.locator('.chat-message')).toHaveCount(0);
});

test('new conversation without an account leads to account setup', async ({ page }) => {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect an account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace settings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('settings traps focus and Escape restores its trigger', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Workspace settings', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Skype exposes separate advanced username and optional discovery', async ({ page }) => {
  const dialog = await accountForm(page);
  await expect(dialog.getByLabel('Sign-in address', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/Advanced login username/)).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByText('Server settings', { exact: true }).click();
  await expect(dialog.getByLabel(/Discovery URL/)).toBeVisible();
});

test('provider switch clears server, advanced username and revealed password state', async ({ page }) => {
  const dialog = await accountForm(page);
  await dialog.getByLabel(/Advanced login username/).fill('SYNTHETIC\\person');
  await dialog.getByText('Server settings', { exact: true }).click();
  await dialog.getByLabel(/Discovery URL/).fill('https://skype.example.org/discover');
  await dialog.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await dialog.getByRole('button', { name: 'Show password', exact: true }).click();
  await dialog.getByRole('button', { name: 'Teamwire', exact: true }).click();
  await expect(dialog.getByLabel('Teamwire server', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Skype for Business', exact: true }).click();
  await expect(dialog.getByLabel(/Advanced login username/)).toHaveValue('');
});

for (const close of ['Close settings', 'Cancel account setup', 'Cancel']) {
  test(`${close} clears credentials and password visibility`, async ({ page }) => {
    let dialog = await accountForm(page);
    await dialog.getByLabel('Password', { exact: true }).fill('synthetic-password');
    await dialog.getByRole('button', { name: 'Show password', exact: true }).click();
    await dialog.getByRole('button', { name: close, exact: true }).click();
    if (close === 'Close settings') dialog = await accountForm(page);
    else await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  });
}

test('browser login fails clearly and never persists credentials', async ({ page }) => {
  const dialog = await accountForm(page);
  await dialog.getByLabel('Sign-in address', { exact: true }).fill('synthetic@example.org');
  await dialog.getByLabel(/Advanced login username/).fill('SYNTHETIC\\person');
  await dialog.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('desktop app');
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('');
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(stored)).not.toMatch(/synthetic-password|SYNTHETIC|synthetic@example/);
  expect(Object.keys(stored.local)).toEqual(['chattahoochee:theme']);
});

test('Teamwire requires an explicit HTTPS server', async ({ page }) => {
  const dialog = await accountForm(page);
  await dialog.getByRole('button', { name: 'Teamwire', exact: true }).click();
  await dialog.getByLabel('Sign-in address', { exact: true }).fill('synthetic@example.org');
  await dialog.getByLabel('Password', { exact: true }).fill('synthetic-password');
  const server = dialog.getByLabel('Teamwire server', { exact: true });
  await expect(server).toHaveAttribute('required', '');
  await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect.poll(() => server.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('invalid email is stopped before submitting the form', async ({ page }) => {
  const dialog = await accountForm(page);
  await dialog.getByLabel('Sign-in address', { exact: true }).fill('invalid-address');
  await dialog.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect.poll(() => dialog.getByLabel('Sign-in address', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

for (const theme of ['Light', 'Dark']) {
  test(`${theme} appearance persists through reload`, async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: theme, exact: true }).click();
    await expect(page.locator('html')).toHaveClass(theme === 'Dark' ? 'dark' : '');
    await page.reload();
    await expect(page.locator('html')).toHaveClass(theme === 'Dark' ? 'dark' : '');
  });
}

test('system theme follows OS changes including the theme toggle label', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByRole('button', { name: 'Switch to dark theme', exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme', exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByRole('button', { name: 'Switch to dark theme', exact: true })).toBeVisible();
});

test('About accurately names preview limitations and closes by keyboard', async ({ page }) => {
  await page.getByRole('button', { name: 'About Chattahoochee', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('screen sharing, and file transfers are not available yet');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
