import type { Page } from '@playwright/test';
import { test, expect, demo, list, composer, transcript, details } from './fixtures';

test.beforeEach(async ({ page }) => demo(page));

async function reopenDetails(page: Page) {
  const close = page.getByRole('button', { name: 'Close conversation details', exact: true });
  if (await close.isVisible()) await close.click();
  const trigger = page.getByRole('button', { name: 'Show conversation details', exact: true });
  await trigger.click();
  await expect(page.getByLabel('Conversation details', { exact: true })).toBeVisible();
  return trigger;
}

test('a filtered unread inbox explains the filter instead of asking for an account', async ({ page }) => {
  await page.getByRole('button', { name: 'Skype', exact: true }).click();
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(list(page).getByRole('heading', { name: 'You’re all caught up', exact: true })).toBeVisible();
  await expect(list(page)).toContainText('There are no unread conversations in this view.');
  await expect(list(page)).not.toContainText('Connect an account');
  await expect(list(page).locator('.conversation-row')).toHaveCount(0);
  await list(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(list(page).locator('.conversation-row')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Unread', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('the inbox visibly identifies each unsent draft without changing the transcript', async ({ page }) => {
  const maya = list(page).getByRole('button', { name: /Maya Chen/ });
  const oliver = list(page).getByRole('button', { name: /Oliver Park/ });
  await composer(page).fill('Finish the Maya reply later');
  await expect(maya.locator('.conversation-preview.has-draft')).toContainText('Draft');
  await expect(maya.locator('.conversation-preview.has-draft')).toContainText('Finish the Maya reply later');
  await expect(oliver.locator('.conversation-preview')).not.toContainText('Draft');
  await expect(transcript(page).locator('.chat-message')).toHaveCount(7);

  await oliver.click();
  await composer(page).fill('An independent Oliver draft');
  await expect(oliver.locator('.conversation-preview.has-draft')).toContainText('An independent Oliver draft');
  await expect(maya.locator('.conversation-preview.has-draft')).toContainText('Finish the Maya reply later');
  await maya.click();
  await expect(composer(page)).toHaveValue('Finish the Maya reply later');
  await composer(page).fill('');
  await expect(maya.locator('.conversation-preview.has-draft')).toHaveCount(0);
  await expect(maya.locator('.conversation-preview')).toHaveText('The little details make all the difference ✨');
});

test('inbox search ignores accidental surrounding whitespace', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('  MAYA CHEN  ');
  await expect(list(page).locator('.conversation-row')).toHaveCount(1);
  await expect(list(page).getByRole('button', { name: /Maya Chen/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('   ');
  await expect(list(page).locator('.conversation-row')).toHaveCount(6);
});

test('clearing the inbox search by keyboard returns focus to the search field', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await search.fill('Oliver');
  await expect(list(page).locator('.conversation-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear search', exact: true }).press('Enter');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toHaveCount(0);
  await expect(list(page).locator('.conversation-row')).toHaveCount(6);
});

test('people search ignores surrounding whitespace in a work address', async ({ page }) => {
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search people', exact: true }).fill('  SOFIA.RIVERA@example.com  ');
  const contacts = page.getByLabel('Contact list', { exact: true });
  await expect(contacts.getByRole('button')).toHaveCount(1);
  await expect(contacts.getByRole('button', { name: /Sofia Rivera/ })).toBeVisible();
});

test('Escape closes the emoji picker and returns focus to its trigger', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Add an emoji', exact: true });
  await composer(page).fill('Keep this draft');
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Insert 👋', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Insert 👋', exact: true })).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(composer(page)).toHaveValue('Keep this draft');
});

test('clicking outside the emoji picker dismisses it without inserting text', async ({ page }) => {
  await composer(page).fill('Unchanged by dismissal');
  const trigger = page.getByRole('button', { name: 'Add an emoji', exact: true });
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Insert 👋', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('heading', { name: 'Maya Chen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Insert 👋', exact: true })).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(composer(page)).toHaveValue('Unchanged by dismissal');
});

test('emoji insertion uses the draft cursor and leaves typing after the emoji', async ({ page }) => {
  await composer(page).fill('Hello world');
  for (let i = 0; i < 5; i++) await composer(page).press('ArrowLeft');
  await page.getByRole('button', { name: 'Add an emoji', exact: true }).click();
  await page.getByRole('button', { name: 'Insert 👋', exact: true }).click();
  await expect(composer(page)).toHaveValue('Hello 👋world');
  await expect(composer(page)).toBeFocused();
  await composer(page).pressSequentially('friend ');
  await expect(composer(page)).toHaveValue('Hello 👋friend world');
  await expect(transcript(page).locator('.chat-message')).toHaveCount(7);
});

for (const action of ['Escape', 'Close'] as const) {
  test(`closing About by ${action} restores its opener`, async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'About Chattahoochee', exact: true });
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: /Good conversations/ });
    await expect(dialog).toBeVisible();
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

for (const action of ['Escape', 'Close'] as const) {
  test(`cancelling a new conversation by ${action} restores its opener`, async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'New conversation', exact: true });
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Find a contact or enter an address', exact: true }).fill('unfinished');
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Close new conversation', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Maya Chen');
  });
}

for (const action of ['Escape', 'Close'] as const) {
  test(`closing conversation details by ${action} restores its trigger`, async ({ page }) => {
    const trigger = await reopenDetails(page);
    const close = page.getByRole('button', { name: 'Close conversation details', exact: true });
    if (action === 'Escape') await close.press('Escape');
    else await close.press('Enter');
    await expect(page.getByLabel('Conversation details', { exact: true })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test('closing the initially open desktop details panel restores the info trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.reload();
  const close = page.getByRole('button', { name: 'Close conversation details', exact: true });
  await expect(close).toBeVisible();
  await close.press('Enter');
  await expect(close).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show conversation details', exact: true })).toBeFocused();
});

test('minimum-width details contain keyboard focus and Escape returns to the conversation', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 640 });
  await page.reload();
  const trigger = await reopenDetails(page);
  const drawer = page.getByRole('dialog', { name: 'Conversation information', exact: true });
  await expect(drawer).toBeVisible();
  const insideDrawer = () => drawer.evaluate(element => element.contains(document.activeElement));
  await expect.poll(insideDrawer).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      await expect.poll(insideDrawer).toBe(true);
    }
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(composer(page)).toBeVisible();
});

test('narrow details hand off to account settings and restore the visible info trigger', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.reload();
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await expect(search).toBeHidden();
  const trigger = page.getByRole('button', { name: 'Show conversation details', exact: true });
  await trigger.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Conversation information', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Manage account', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(composer(page)).toBeVisible();
  await expect(search).toBeHidden();
});

test('narrow new-conversation account handoff restores the original welcome opener', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Connect your first account', exact: true });
  await expect(opener).toBeVisible();
  await opener.press('ControlOrMeta+n');
  const newConversation = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await expect(newConversation).toBeVisible();
  await newConversation.getByRole('button', { name: 'Connect an account', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(newConversation).toHaveCount(0);
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('changing a conversation resets its details from Files to Overview', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.reload();
  const panel = await details(page);
  await panel.getByRole('tab', { name: /^Files/ }).click();
  await expect(panel.getByRole('tabpanel')).toContainText('Workspace explorations.pdf');
  await list(page).getByRole('button', { name: /Oliver Park/ }).click();
  await expect(panel.getByRole('heading', { name: 'Oliver Park', exact: true })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tab', { name: /^Files/ })).toHaveAttribute('aria-selected', 'false');
  await expect(panel.getByRole('tabpanel')).toContainText('IN THIS CONVERSATION');
  await expect(panel.getByRole('tabpanel')).not.toContainText('Workspace explorations.pdf');
});

test('opening a person with the keyboard moves focus into their composer', async ({ page }) => {
  await page.getByRole('button', { name: 'People', exact: true }).press('Enter');
  await page.getByLabel('Contact list', { exact: true }).getByRole('button', { name: /Sofia Rivera/ }).press('Enter');
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Sofia Rivera');
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue('');
  await expect(transcript(page).getByText('Thanks for the thoughtful feedback!', { exact: true })).toBeVisible();
});

test('message text and the composer remain readable at the configured viewport', async ({ page }) => {
  for (const [description, element] of [
    ['message text', transcript(page).locator('.chat-bubble p').first()],
    ['message composer', composer(page)],
    ['conversation title', list(page).locator('.conversation-title').first()],
  ] as const) {
    await expect(element).toBeVisible();
    const fontSize = await element.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(fontSize, `${description} must remain at least 14px at ${page.viewportSize()?.width}px`).toBeGreaterThanOrEqual(14);
  }
});

test('search shortcut reveals the inbox when a narrow conversation is open', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await expect(search).toBeHidden();
  await composer(page).click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('Oliver');
  await expect(list(page).locator('.conversation-row')).toHaveCount(1);
  await expect(list(page).getByRole('button', { name: /Oliver Park/ })).toBeVisible();
});

test('selecting a conversation in the narrow inbox focuses its visible composer', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.reload();
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).press('Enter');
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await list(page).getByRole('button', { name: /Oliver Park/ }).press('Enter');
  await expect(page.getByRole('main')).toHaveAttribute('aria-label', 'Conversation with Oliver Park');
  await expect(search).toBeHidden();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await expect(transcript(page).getByText('Sounds good. See you there!', { exact: true })).toBeVisible();
});

test('starting a conversation from the narrow inbox reveals it and focuses its composer', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.reload();
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).press('Enter');
  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await expect(search).toBeVisible();
  await page.getByRole('button', { name: 'New conversation', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Send from', exact: true })).toHaveValue('demo:teamwire');
  await dialog.getByRole('button', { name: /Sofia Rivera/ }).press('Enter');
  await expect(dialog).toHaveCount(0);
  const conversation = page.getByRole('main', { name: 'Conversation with Sofia Rivera', exact: true });
  await expect(conversation).toBeVisible();
  await expect(search).toBeHidden();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await expect(transcript(page).getByText('Thanks for the thoughtful feedback!', { exact: true })).toBeVisible();
});
