import { test, expect, demo, composer, list, details, transcript } from './fixtures';

test('minimum layout keeps controls reachable with details open and closed', async ({ page }) => {
  await demo(page);
  const panel = await details(page);
  const viewport = page.viewportSize()!;
  if (viewport.width <= 1099) {
    const drawer = page.getByRole('dialog', { name: 'Conversation information', exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => {
      const bounds = await drawer.boundingBox();
      return bounds && {
        top: Math.round(bounds.y),
        right: Math.round(bounds.x + bounds.width),
        height: Math.round(bounds.height),
      };
    }, 'The details drawer must align with the top and right of the viewport at full height').toEqual({
      top: 0,
      right: viewport.width,
      height: viewport.height,
    });
  }
  for (const name of ['Close conversation details', 'Pinned conversation']) {
    const control = panel.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds, `${name} must have measurable bounds`).not.toBeNull();
    expect(bounds!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
    expect(bounds!.y, `${name} top edge`).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, `${name} right edge`).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height, `${name} bottom edge`).toBeLessThanOrEqual(viewport.height);
  }
  await panel.getByRole('button', { name: 'Close conversation details', exact: true }).click();
  await composer(page).fill('Layout check');
  const bounds = await page.getByRole('button', { name: 'Send demo message', exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('resizing across details breakpoints never covers Send after dismissing the drawer', async ({ page }) => {
  await demo(page);
  for (const width of [1600, 1227, 1099, 980, 1360]) {
    await page.setViewportSize({ width, height: 760 });
    await details(page);
    await page.getByRole('button', { name: 'Close conversation details', exact: true }).click();
    await composer(page).fill(`At ${width}`);
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await expect(transcript(page).getByText(`At ${width}`, { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('long unbroken text wraps within the transcript', async ({ page }) => {
  await demo(page);
  await composer(page).fill('LongWord'.repeat(700));
  await composer(page).press('Enter');
  await expect(transcript(page).locator('.chat-message')).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const overflow = await transcript(page).evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
});

test('refresh drops messages and drafts but retains appearance', async ({ page }) => {
  await demo(page);
  await composer(page).fill('A temporary demo message');
  await composer(page).press('Enter');
  await composer(page).fill('A temporary draft');
  await page.reload();
  await expect(composer(page)).toHaveValue('');
  await expect(transcript(page).getByText('A temporary demo message', { exact: true })).toHaveCount(0);
});

test('repeated demo resets do not accumulate DOM or state', async ({ page }) => {
  await demo(page);
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: 'Leave demo', exact: true }).click();
    await expect(page.locator('.chat-message')).toHaveCount(0);
    await page.getByRole('button', { name: /Take a look around/ }).click();
    await expect(list(page).getByRole('button')).toHaveCount(6);
    await expect(page.locator('.transcript-content')).toHaveCount(1);
    await expect(transcript(page).locator('.chat-message')).toHaveCount(7);
  }
});

test('new-conversation search is reset when reopened', async ({ page }) => {
  await demo(page);
  const trigger = page.getByRole('button', { name: 'New conversation', exact: true });
  await trigger.click();
  await page.getByRole('textbox', { name: 'Find a contact or enter an address', exact: true }).fill('unknown');
  await page.getByRole('button', { name: 'Close new conversation', exact: true }).click();
  await trigger.click();
  await expect(page.getByRole('textbox', { name: 'Find a contact or enter an address', exact: true })).toHaveValue('');
});

test('a clean browser context has no persisted demo messages or credentials', async ({ page, browser }) => {
  await demo(page);
  await composer(page).fill('Private local demo text');
  await composer(page).press('Enter');
  const isolated = await browser.newContext();
  try {
    const other = await isolated.newPage();
    await other.goto('http://127.0.0.1:1430/');
    await expect(other.getByRole('heading', { name: 'A fresh start', exact: true })).toBeVisible();
    await expect(other.locator('.chat-message')).toHaveCount(0);
  } finally { await isolated.close(); }
});

test('reduced motion still renders and sends normally', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await demo(page);
  await composer(page).fill('Reduced motion works');
  await composer(page).press('Enter');
  await expect(transcript(page).getByText('Reduced motion works', { exact: true })).toHaveCount(1);
});
