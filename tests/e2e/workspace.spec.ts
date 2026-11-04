import { test, expect, demo, list, composer, transcript, details } from './fixtures';

test.beforeEach(async ({ page }) => demo(page));

test('demo opens both providers and one transcript', async ({ page }) => {
  await expect(page.getByText('Demo workspace', { exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Maya Chen');
  await expect(page.locator('.transcript-content')).toHaveCount(1);
  await expect(transcript(page).locator('.chat-message')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Manage Skype for Business', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage Teamwire', exact: true })).toBeVisible();
});

for (const [name, text, count] of [
  ['Maya Chen', 'The little details make all the difference ✨', 7],
  ['Design studio', 'Just added the updated explorations. Looking forward to your thoughts!', 3],
  ['Oliver Park', 'Sounds good. See you there!', 2],
  ['Launch crew', 'Everything is ready for tomorrow 🚀', 2],
  ['Sofia Rivera', 'Thanks for the thoughtful feedback!', 1],
  ['Noah Williams', 'I’ll take a look after lunch.', 1],
] as const) {
  test(`conversation switch: ${name} has only its own transcript`, async ({ page }) => {
    await list(page).getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByRole('main')).toHaveAttribute('aria-label', `Conversation with ${name}`);
    await expect(transcript(page).locator('.chat-message')).toHaveCount(count);
    await expect(transcript(page).getByText(text, { exact: true })).toHaveCount(1);
    await expect(page.locator('#message-composer')).toHaveCount(1);
  });
}

for (const query of ['maya', 'MAYA CHEN', 'little details']) {
  test(`search matches names and previews: ${query}`, async ({ page }) => {
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill(query);
    await expect(list(page).getByRole('button')).toHaveCount(1);
    await expect(list(page).getByRole('button')).toContainText('Maya Chen');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(list(page).getByRole('button')).toHaveCount(6);
  });
}

test('empty search resets all filters', async ({ page }) => {
  await page.locator('.provider-filters').getByRole('button', { name: 'Skype', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('not a real contact');
  await expect(list(page).getByRole('heading', { name: 'No matches just yet' })).toBeVisible();
  await list(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(list(page).getByRole('button')).toHaveCount(6);
});

for (const provider of ['Skype', 'Teamwire']) {
  test(`${provider} filter shows only that provider`, async ({ page }) => {
    await page.locator('.provider-filters').getByRole('button', { name: provider, exact: true }).click();
    await expect(list(page).getByRole('button')).toHaveCount(3);
    for (const row of await list(page).getByRole('button').all()) await expect(row).toContainText(provider);
  });
}

test('unread filter clears a selected conversation', async ({ page }) => {
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(list(page).getByRole('button')).toHaveCount(2);
  await list(page).getByRole('button', { name: /Design studio/ }).click();
  await expect(list(page).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Design studio');
});

test('pinning changes the pinned inbox immediately', async ({ page }) => {
  const panel = await details(page);
  await panel.getByRole('button', { name: 'Pinned conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Close conversation details', exact: true }).click();
  await page.getByRole('button', { name: 'Pinned conversations', exact: true }).click();
  await expect(list(page).getByRole('button')).toHaveCount(2);
  await expect(list(page).getByRole('button', { name: /Maya Chen/ })).toHaveCount(0);
});

test('Enter sends once, clears the draft and retains keyboard focus', async ({ page }) => {
  await composer(page).fill('A single synthetic message');
  await composer(page).press('Enter');
  await expect(transcript(page).getByText('A single synthetic message', { exact: true })).toHaveCount(1);
  await expect(composer(page)).toHaveValue('');
  await expect(composer(page)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Send demo message', exact: true })).toBeDisabled();
});

test('Shift+Enter preserves multiline text until explicit send', async ({ page }) => {
  await composer(page).fill('First line');
  await composer(page).press('Shift+Enter');
  await composer(page).pressSequentially('Second line');
  await expect(composer(page)).toHaveValue('First line\nSecond line');
  await expect(transcript(page).locator('.chat-message')).toHaveCount(7);
  await composer(page).press('Enter');
  await expect(transcript(page).getByText('First line\nSecond line', { exact: true })).toHaveCount(1);
});

test('whitespace never enables sending or creates a message', async ({ page }) => {
  await composer(page).fill('  \n\t ');
  await expect(page.getByRole('button', { name: 'Send demo message', exact: true })).toBeDisabled();
  await composer(page).press('Enter');
  await expect(transcript(page).locator('.chat-message')).toHaveCount(7);
});

for (const text of ['Grüße aus Köln – äöü ß', 'مرحبا بالعالم', '你好，世界 👋🏽', '<script>throw Error("xss")</script>', 'https://example.org/?q=<unsafe>&x=1']) {
  test(`messages remain inert Unicode text: ${text.slice(0, 24)}`, async ({ page }) => {
    await composer(page).fill(text);
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await expect(transcript(page).locator('.chat-bubble p').last()).toHaveText(text);
    await expect(transcript(page).locator('script, iframe')).toHaveCount(0);
  });
}

test('emoji insertion retains a draft and returns focus', async ({ page }) => {
  await composer(page).fill('Hello ');
  await page.getByRole('button', { name: 'Add an emoji', exact: true }).click();
  await page.getByRole('button', { name: 'Insert 👋', exact: true }).click();
  await expect(composer(page)).toHaveValue('Hello 👋');
  await expect(composer(page)).toBeFocused();
});

test('drafts remain isolated while switching conversations', async ({ page }) => {
  await composer(page).fill('Only for Maya');
  await list(page).getByRole('button', { name: /Oliver Park/ }).click();
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('Only for Oliver');
  await list(page).getByRole('button', { name: /Maya Chen/ }).click();
  await expect(composer(page)).toHaveValue('Only for Maya');
  await list(page).getByRole('button', { name: /Oliver Park/ }).click();
  await expect(composer(page)).toHaveValue('Only for Oliver');
});

test('leaving and reopening demo resets drafts, search and provider filters', async ({ page }) => {
  await composer(page).fill('Discard this demo draft');
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('Oliver');
  await page.locator('.provider-filters').getByRole('button', { name: 'Skype', exact: true }).click();
  await page.getByRole('button', { name: 'Leave demo', exact: true }).click();
  await page.getByRole('button', { name: /Take a look around/ }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Search conversations', exact: true })).toHaveValue('');
  await expect(list(page).getByRole('button')).toHaveCount(6);
});

test('rapid alternating messages never duplicate or cross conversations', async ({ page }) => {
  for (let i = 0; i < 12; i++) {
    const name = i % 2 ? 'Oliver Park' : 'Maya Chen';
    await list(page).getByRole('button', { name: new RegExp(name) }).click();
    await composer(page).fill(`Smoke message ${i}`);
    await composer(page).press('Enter');
    await expect(transcript(page).getByText(`Smoke message ${i}`, { exact: true })).toHaveCount(1);
    if (i) await expect(transcript(page).getByText(`Smoke message ${i - 1}`, { exact: true })).toHaveCount(0);
  }
});

test('conversation information tabs support keyboard navigation', async ({ page }) => {
  const panel = await details(page);
  const overview = panel.getByRole('tab', { name: 'Overview', exact: true });
  const files = panel.getByRole('tab', { name: 'Files 1', exact: true });
  await overview.focus();
  await overview.press('ArrowRight');
  await expect(files).toBeFocused();
  await expect(files).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tabpanel')).toContainText('Workspace explorations.pdf');
  await files.press('Home');
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('aria-selected', 'true');
});

test('people and new conversation stay scoped to the selected account', async ({ page }) => {
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.getByLabel('Contact list', { exact: true }).getByRole('button')).toHaveCount(4);
  await page.getByLabel('Contact list', { exact: true }).getByRole('button', { name: /Oliver Park/ }).click();
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Oliver Park');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await dialog.getByRole('combobox', { name: 'Send from', exact: true }).selectOption('demo:teamwire');
  await expect(dialog.getByRole('button', { name: /Maya Chen/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Oliver Park/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Maya Chen');
});

test('unimplemented capabilities remain visibly disabled', async ({ page }) => {
  for (const name of ['Audio calling', 'Video calling', 'Screen sharing', 'File attachments']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${name}.*not available`) })).toBeDisabled();
  }
});
