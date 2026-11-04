import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessengerStore, mergeDelivery } from '../src/model/store';
import { NativeAccountTransport } from '../src/lib/native-transport';
import { scopedId, type AccountConnector, type ConnectorContext } from '../src/connectors/types';
import type { AccountInput, Conversation, Message } from '../src/model/types';

const input: AccountInput = { provider: 'teamwire', address: 'person@example.org', loginUsername: 'separate-user', password: 'synthetic-secret', server: 'https://chat.example.org' };
class FakeTransport extends NativeAccountTransport {
  allowed: string[] = [];
  closed = 0;
  override async allowOrigins(origins: readonly string[]) { this.allowed.push(...origins); }
  override async close() { this.closed++; }
  override readonly fetch: typeof fetch = async () => { throw new Error('Synthetic transport must not reach the network.'); };
}
class FakeConnector implements AccountConnector {
  context!: ConnectorContext;
  disconnected = 0;
  sent = 0;
  onConnect?: (context: ConnectorContext) => Promise<void>;
  onSend?: (conversation: Conversation, body: string, id: string) => Promise<void>;
  async connect(_input: AccountInput, context: ConnectorContext) { this.context = context; await this.onConnect?.(context); }
  async disconnect() { this.disconnected++; }
  async sendMessage(conversation: Conversation, body: string, id: string) { this.sent++; await this.onSend?.(conversation, body, id); }
  async startConversation() {}
  async setTyping() {}
}
function harness(onCreate?: (connector: FakeConnector) => void) {
  const connectors: FakeConnector[] = [];
  const transports: FakeTransport[] = [];
  const store = new MessengerStore({ isDesktop: () => true,
    connectorFactory: () => { const connector = new FakeConnector(); connectors.push(connector); onCreate?.(connector); return connector; },
    transportFactory: (id) => { const transport = new FakeTransport(id); transports.push(transport); return transport; },
  });
  return { store, connectors, transports };
}
function conversation(accountId: string, nativeId = 'same-native-id'): Conversation {
  return { id: scopedId(accountId, nativeId), accountId, nativeId, provider: 'teamwire', title: 'Example chat', initials: 'EC', color: 'sage', participants: ['Someone'], preview: '', updatedAt: '2026-11-04T10:00:00.000Z', unread: 0, pinned: false, group: false, presence: 'unknown', capabilities: { sendMessages: true, typing: false, markRead: false, attachments: false, audio: false, video: false, screenSharing: false } };
}
function message(chat: Conversation, id = 'native-message'): Message {
  return { id: scopedId(chat.accountId, id), accountId: chat.accountId, conversationId: chat.id, senderId: 'someone', senderName: 'Someone', body: 'A synthetic message', createdAt: '2026-11-04T10:01:00.000Z', direction: 'incoming', delivery: 'delivered' };
}

test('snapshots are cached and connection state never contains login secrets', async () => {
  const { store } = harness();
  const first = store.getSnapshot();
  assert.equal(store.getSnapshot(), first);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  await store.connectAccount(input);
  assert.notEqual(store.getSnapshot(), first);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'connected');
  assert.equal(JSON.stringify(store.getSnapshot()).includes(input.password), false);
  assert.equal(JSON.stringify(store.getSnapshot()).includes(input.loginUsername!), false);
  assert.ok(notifications >= 2);
  unsubscribe();
  await store.close();
});

test('equal native ids remain isolated between accounts and mismatched events are rejected', async () => {
  const { store, connectors } = harness();
  await store.connectAccount(input); await store.connectAccount({ ...input, provider: 'skype' });
  const [first, second] = store.getSnapshot().accounts;
  const a = conversation(first!.id); const b = conversation(second!.id);
  connectors[0]!.context.emit({ type: 'conversation', conversation: a });
  connectors[1]!.context.emit({ type: 'conversation', conversation: b });
  connectors[0]!.context.emit({ type: 'message', message: message(a) });
  connectors[1]!.context.emit({ type: 'message', message: message(b) });
  connectors[0]!.context.emit({ type: 'message', message: message(b, 'cross-account') });
  connectors[0]!.context.emit({ type: 'conversation', conversation: { ...b, accountId: a.accountId } });
  assert.equal(store.getSnapshot().conversations.length, 2);
  assert.equal(store.getSnapshot().messages[a.id]?.length, 1);
  assert.equal(store.getSnapshot().messages[b.id]?.length, 1);
  assert.notEqual(store.getSnapshot().messages[a.id]?.[0]?.id, store.getSnapshot().messages[b.id]?.[0]?.id);
  await store.close();
});

test('history and replay do not inflate unread counts or move a conversation backwards', async () => {
  const { store, connectors } = harness(); await store.connectAccount(input);
  const accountId = store.getSnapshot().accounts[0]!.id;
  const selected = conversation(accountId, 'selected'); const other = conversation(accountId, 'other');
  connectors[0]!.context.emit({ type: 'conversation', conversation: selected });
  connectors[0]!.context.emit({ type: 'conversation', conversation: other });
  const incoming = message(other);
  connectors[0]!.context.emit({ type: 'message', message: incoming });
  connectors[0]!.context.emit({ type: 'message', message: incoming });
  connectors[0]!.context.emit({ type: 'message', historical: true, message: { ...message(other, 'older'), createdAt: '2026-01-01T10:00:00.000Z' } });
  const result = store.getSnapshot().conversations.find(value => value.id === other.id)!;
  assert.equal(result.unread, 1); assert.equal(result.updatedAt, incoming.createdAt);
  assert.equal(store.getSnapshot().messages[other.id]?.length, 2);
  store.selectConversation(other.id);
  assert.equal(store.getSnapshot().conversations.find(value => value.id === other.id)?.unread, 0);
  await store.close();
});

test('optimistic messages reconcile server echo ids and preserve delivery proof across races', async () => {
  const { store, connectors } = harness(); await store.connectAccount(input);
  const chat = conversation(store.getSnapshot().accounts[0]!.id);
  connectors[0]!.context.emit({ type: 'conversation', conversation: chat });
  connectors[0]!.onSend = async (_chat, body, operationId) => {
    const optimisticId = scopedId(chat.accountId, operationId);
    assert.equal(store.getSnapshot().messages[chat.id]?.find(value => value.id === optimisticId)?.delivery, 'pending');
    const echo = { ...message(chat, 'server-id'), direction: 'outgoing' as const, body, delivery: 'accepted' as const };
    connectors[0]!.context.emit({ type: 'message', message: echo });
    connectors[0]!.context.emit({ type: 'message', replacesMessageId: echo.id, message: { ...echo, id: optimisticId } });
    connectors[0]!.context.emit({ type: 'delivery', messageId: optimisticId, conversationId: chat.id, delivery: 'delivered' });
    throw new Error('Synthetic late network error');
  };
  await store.sendMessage(chat.id, 'Only once');
  assert.equal(connectors[0]!.sent, 1);
  assert.equal(store.getSnapshot().messages[chat.id]?.length, 1);
  assert.equal(store.getSnapshot().messages[chat.id]?.[0]?.delivery, 'delivered');
  await store.close();
});

test('HTTP completion cannot overwrite a provider rejection and failed writes never retry', async () => {
  const { store, connectors } = harness(); await store.connectAccount(input);
  const chat = conversation(store.getSnapshot().accounts[0]!.id);
  connectors[0]!.context.emit({ type: 'conversation', conversation: chat });
  connectors[0]!.onSend = async (_chat, _body, operationId) => connectors[0]!.context.emit({ type: 'delivery', messageId: scopedId(chat.accountId, operationId), conversationId: chat.id, delivery: 'failed' });
  await store.sendMessage(chat.id, 'Protocol rejection');
  assert.equal(store.getSnapshot().messages[chat.id]?.[0]?.delivery, 'failed');
  connectors[0]!.onSend = async () => { throw new Error('Synthetic write failure'); };
  await assert.rejects(store.sendMessage(chat.id, 'No automatic retry'));
  assert.equal(connectors[0]!.sent, 2);
  assert.equal(store.getSnapshot().messages[chat.id]?.[1]?.delivery, 'failed');
  await store.close();
});

test('disconnect during origin approval cancels setup and cleanup exactly once', async () => {
  let approvalResult: boolean | undefined;
  const { store, connectors, transports } = harness(connector => { connector.onConnect = async context => { approvalResult = await context.approveOrigin('https://pool.example.org'); context.signal.throwIfAborted(); }; });
  const pending = store.connectAccount(input);
  await new Promise(resolve => setTimeout(resolve, 0));
  const account = store.getSnapshot().accounts[0]!;
  assert.equal(store.getSnapshot().originApprovals.length, 1);
  await store.disconnectAccount(account.id); await pending;
  assert.equal(approvalResult, false);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(store.getSnapshot().originApprovals.length, 0);
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(connectors[0]!.disconnected, 1);
  assert.equal(transports[0]!.closed, 1);
});

test('approved service origins belong only to the requesting account', async () => {
  const { store, connectors, transports } = harness();
  await store.connectAccount(input); await store.connectAccount(input);
  const approval = connectors[0]!.context.approveOrigin('https://pool.example.org');
  store.approveOrigin(store.getSnapshot().originApprovals[0]!.id, true);
  assert.equal(await approval, true);
  assert.ok(transports[0]!.allowed.includes('https://pool.example.org'));
  assert.ok(!transports[1]!.allowed.includes('https://pool.example.org'));
  await store.close();
});

test('demo is explicit and cannot invoke live connector or account transport', async () => {
  let liveCalls = 0;
  const store = new MessengerStore({ isDesktop: () => true, connectorFactory: () => { liveCalls++; throw new Error('Unexpected live call'); } });
  assert.equal(store.getSnapshot().mode, 'live'); assert.equal(store.getSnapshot().conversations.length, 0);
  store.enterDemo();
  const selected = store.getSnapshot().selectedConversationId!;
  await store.sendMessage(selected, 'Local demo only');
  await assert.rejects(store.connectAccount(input));
  assert.equal(liveCalls, 0);
  assert.equal(store.getSnapshot().messages[selected]?.at(-1)?.delivery, 'accepted');
  store.exitDemo();
  assert.equal(store.getSnapshot().accounts.length, 0); assert.deepEqual(store.getSnapshot().messages, {});
});

test('browser preview rejects live login and disconnected accounts cannot send', async () => {
  const preview = new MessengerStore({ isDesktop: () => false });
  await assert.rejects(preview.connectAccount(input), /desktop app/);
  const { store, connectors } = harness(); await store.connectAccount(input);
  const chat = conversation(store.getSnapshot().accounts[0]!.id);
  connectors[0]!.context.emit({ type: 'conversation', conversation: chat });
  await store.disconnectAccount(chat.accountId);
  await assert.rejects(store.sendMessage(chat.id, 'Do not send'));
  assert.equal(connectors[0]!.sent, 0);
});

test('delivery state honors confirmed provider acceptance and never downgrades recipient proof', () => {
  assert.equal(mergeDelivery('delivered', 'accepted'), 'delivered');
  assert.equal(mergeDelivery('read', 'failed'), 'read');
  assert.equal(mergeDelivery('failed', 'accepted'), 'failed');
  assert.equal(mergeDelivery('failed', 'accepted', true), 'accepted');
  assert.equal(mergeDelivery('failed', 'delivered'), 'delivered');
});
