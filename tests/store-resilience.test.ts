import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessengerStore } from '../src/model/store';
import { NativeAccountTransport } from '../src/lib/native-transport';
import { scopedId, type AccountConnector, type ConnectorContext } from '../src/connectors/types';
import type { AccountInput, Contact, Conversation, Message, Provider } from '../src/model/types';

const input: AccountInput = { provider: 'teamwire', address: 'person@example.org', password: 'synthetic-password', server: 'https://chat.example.org' };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
class Transport extends NativeAccountTransport {
  closed = 0;
  allowed: string[] = [];
  override async allowOrigins(origins: readonly string[]) { this.allowed.push(...origins); }
  override async close() { this.closed++; }
}
class Connector implements AccountConnector {
  context!: ConnectorContext;
  disconnected = 0;
  started: string[] = [];
  typed: string[] = [];
  sent: { conversation: Conversation; body: string; id: string }[] = [];
  loaded: string[] = [];
  read: string[] = [];
  onConnect?: (context: ConnectorContext) => Promise<void>;
  onDisconnect?: () => Promise<void>;
  onSend?: () => Promise<void>;
  onStart?: () => Promise<void>;
  onLoad?: () => Promise<void>;
  onRead?: () => Promise<void>;
  async connect(_input: AccountInput, context: ConnectorContext) { this.context = context; await this.onConnect?.(context); }
  async disconnect() { this.disconnected++; await this.onDisconnect?.(); }
  async sendMessage(conversation: Conversation, body: string, id: string) { this.sent.push({ conversation, body, id }); await this.onSend?.(); }
  async startConversation(address: string) { this.started.push(address); await this.onStart?.(); }
  async setTyping(conversation: Conversation) { this.typed.push(conversation.id); }
  async loadConversation(conversation: Conversation) { this.loaded.push(conversation.id); await this.onLoad?.(); }
  async markRead(conversation: Conversation) { this.read.push(conversation.id); await this.onRead?.(); }
}
function harness(configure?: (connector: Connector) => void) {
  const connectors: Connector[] = [];
  const transports: Transport[] = [];
  const store = new MessengerStore({ isDesktop: () => true,
    connectorFactory: () => { const connector = new Connector(); configure?.(connector); connectors.push(connector); return connector; },
    transportFactory: id => { const transport = new Transport(id); transports.push(transport); return transport; },
  });
  return { store, connectors, transports };
}
function chat(accountId: string, nativeId = 'chat', provider: Provider = 'teamwire'): Conversation {
  return { id: scopedId(accountId, nativeId), accountId, nativeId, provider, title: 'Synthetic chat', initials: 'SC', color: 'sage', participants: ['Person'], preview: 'Recent preview', updatedAt: '2026-11-04T10:00:00.000Z', unread: 0, pinned: false, group: false, presence: 'unknown', capabilities: { sendMessages: true, typing: true, markRead: true, attachments: false, audio: false, video: false, screenSharing: false } };
}
function person(conversation: Conversation): Contact {
  return { id: scopedId(conversation.accountId, 'person'), accountId: conversation.accountId, nativeId: 'person', provider: conversation.provider, name: 'Synthetic person', address: 'synthetic@example.org', initials: 'SP', color: 'sage', presence: 'unknown' };
}
function incoming(conversation: Conversation, nativeId = 'message'): Message {
  return { id: scopedId(conversation.accountId, nativeId), accountId: conversation.accountId, conversationId: conversation.id, senderId: 'person', senderName: 'Person', body: 'Synthetic message', createdAt: '2026-11-04T10:01:00.000Z', direction: 'incoming', delivery: 'delivered' };
}
async function connected(configure?: (connector: Connector) => void) {
  const context = harness(configure);
  await context.store.connectAccount(input);
  const accountId = context.store.getSnapshot().accounts[0]!.id;
  const conversation = chat(accountId);
  const connector = context.connectors[0]!;
  connector.context.emit({ type: 'conversation', conversation });
  return { ...context, accountId, conversation, connector };
}

test('provider-mismatched contacts and conversations cannot enter an account', async () => {
  const { store, connector, accountId } = await connected();
  const foreign = chat(accountId, 'wrong-provider', 'skype');
  connector.context.emit({ type: 'conversation', conversation: foreign });
  connector.context.emit({ type: 'contact', contact: person(foreign) });
  assert.equal(store.getSnapshot().conversations.length, 1);
  assert.equal(store.getSnapshot().contacts.length, 0);
  await store.close();
});

for (const operation of ['load', 'read'] as const) {
  test(`late ${operation} failure after logout cannot publish into a new demo workspace`, async () => {
    const pending = deferred();
    const { store, connector, accountId, conversation } = await connected(connector => { if (operation === 'load') connector.onLoad = () => pending.promise; else connector.onRead = () => pending.promise; });
    store.selectConversation(conversation.id);
    assert.equal((operation === 'load' ? connector.loaded : connector.read).length, 1);
    await store.disconnectAccount(accountId);
    store.enterDemo();
    const snapshot = store.getSnapshot();
    pending.reject(new Error('Synthetic delayed failure'));
    await settle();
    assert.equal(store.getSnapshot(), snapshot);
    assert.equal(store.getSnapshot().notice, null);
  });
}

test('late send rejection cannot restore a live message key after demo reset', async () => {
  const pending = deferred();
  const { store, accountId, conversation } = await connected(connector => { connector.onSend = () => pending.promise; });
  const result = store.sendMessage(conversation.id, 'Pending during logout');
  const rejected = assert.rejects(result, /disconnected|cancel|abort/i);
  await store.disconnectAccount(accountId);
  store.enterDemo();
  const snapshot = store.getSnapshot();
  pending.reject(new Error('Synthetic delayed failure'));
  await rejected;
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(store.getSnapshot().messages[conversation.id], undefined);
});

test('late send completion cannot mark an unconfirmed disconnected message accepted', async () => {
  const pending = deferred();
  const { store, accountId, conversation } = await connected(connector => { connector.onSend = () => pending.promise; });
  const result = store.sendMessage(conversation.id, 'Pending during logout');
  const rejected = assert.rejects(result, /disconnected|cancel|abort/i);
  await store.disconnectAccount(accountId);
  pending.resolve();
  await rejected;
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
});

test('a terminal session failure settles pending messages without claiming delivery', async () => {
  const pending = deferred();
  const { store, connector, conversation } = await connected(connector => { connector.onSend = () => pending.promise; });
  const sending = store.sendMessage(conversation.id, 'Uncertain write');
  const rejected = assert.rejects(sending, /disconnected|cancel|abort/i);
  connector.context.emit({ type: 'error', message: 'Synthetic synchronization failure' });
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
  pending.reject(new Error('Synthetic delayed failure'));
  await rejected;
  assert.equal(connector.sent.length, 1);
  assert.equal(store.getSnapshot().conversations[0]!.capabilities.sendMessages, false);
  await store.close();
});

for (const status of ['connecting', 'error'] as const) {
  test(`${status} accounts cannot start a chat or send typing`, async () => {
    const setup = deferred();
    const { store, connectors } = harness(connector => { if (status === 'connecting') connector.onConnect = () => setup.promise; });
    const result = store.connectAccount(input);
    await settle();
    const accountId = store.getSnapshot().accounts[0]!.id;
    const conversation = chat(accountId);
    connectors[0]!.context.emit({ type: 'conversation', conversation });
    if (status === 'error') connectors[0]!.context.emit({ type: 'error', message: 'Synthetic session failure' });
    await assert.rejects(store.startConversation(accountId, 'somebody@example.org'), /connected account/);
    store.setTyping(conversation.id);
    assert.deepEqual(connectors[0]!.started, []);
    assert.deepEqual(connectors[0]!.typed, []);
    setup.resolve();
    await result;
    await store.close();
  });
}

test('an errored account rejects a send before creating an optimistic message', async () => {
  const { store, connector, conversation } = await connected();
  connector.context.emit({ type: 'error', message: 'Synthetic session failure' });
  const before = store.getSnapshot();
  await assert.rejects(store.sendMessage(conversation.id, 'Offline text'), /connected/);
  assert.equal(store.getSnapshot(), before);
  assert.equal(connector.sent.length, 0);
  await store.close();
});

test('a recoverable action failure preserves connected state and existing chats', async () => {
  const { store, connector, conversation } = await connected();
  connector.context.emit({ type: 'error', message: 'Synthetic invitation failure', recoverable: true });
  assert.equal(store.getSnapshot().accounts[0]!.status, 'connected');
  assert.equal(store.getSnapshot().notice?.message, 'Synthetic invitation failure');
  await store.sendMessage(conversation.id, 'Still connected');
  assert.equal(connector.sent.length, 1);
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'accepted');
  await store.close();
});

test('reconciliation with a new server id retains confirmed delivery', async () => {
  const { store, connector, conversation } = await connected();
  connector.onSend = async () => {
    const optimistic = store.getSnapshot().messages[conversation.id]![0]!;
    connector.context.emit({ type: 'delivery', conversationId: conversation.id, messageId: optimistic.id, delivery: 'read' });
    connector.context.emit({ type: 'message', replacesMessageId: optimistic.id, message: { ...optimistic, id: scopedId(conversation.accountId, 'server-id'), delivery: 'accepted' } });
  };
  await store.sendMessage(conversation.id, 'Do not lose proof');
  const messages = store.getSnapshot().messages[conversation.id]!;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.delivery, 'read');
  await store.close();
});

test('replacement of an unread incoming message never counts it twice', async () => {
  const { store, connector, accountId } = await connected();
  const other = chat(accountId, 'other');
  connector.context.emit({ type: 'conversation', conversation: other });
  const first = incoming(other, 'temporary');
  connector.context.emit({ type: 'message', message: first });
  connector.context.emit({ type: 'message', replacesMessageId: first.id, message: { ...first, id: scopedId(accountId, 'canonical') } });
  assert.equal(store.getSnapshot().messages[other.id]?.length, 1);
  assert.equal(store.getSnapshot().conversations.find(value => value.id === other.id)?.unread, 1);
  await store.close();
});

test('older history cannot replace a newer conversation preview', async () => {
  const { store, connector, conversation } = await connected();
  connector.context.emit({ type: 'message', historical: true, message: { ...incoming(conversation), body: 'Old history', createdAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(store.getSnapshot().conversations[0]!.preview, 'Recent preview');
  assert.equal(store.getSnapshot().conversations[0]!.updatedAt, conversation.updatedAt);
  await store.close();
});

test('an origin refusal never broadens transport permissions', async () => {
  const { store, connector, transports } = await connected();
  const allowed = [...transports[0]!.allowed];
  const approval = connector.context.approveOrigin('https://new-pool.example.org');
  store.approveOrigin(store.getSnapshot().originApprovals[0]!.id, false);
  assert.equal(await approval, false);
  assert.deepEqual(transports[0]!.allowed, allowed);
  assert.deepEqual(store.getSnapshot().originApprovals, []);
  await store.close();
});

test('disconnect cancels all approval prompts while preserving other accounts', async () => {
  const { store, connectors } = harness();
  await store.connectAccount(input);
  await store.connectAccount(input);
  const first = connectors[0]!.context.approveOrigin('https://one.example.org');
  const second = connectors[0]!.context.approveOrigin('https://two.example.org');
  const other = connectors[1]!.context.approveOrigin('https://other.example.org');
  const accountId = store.getSnapshot().accounts[0]!.id;
  await store.disconnectAccount(accountId);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(store.getSnapshot().originApprovals.length, 1);
  store.approveOrigin(store.getSnapshot().originApprovals[0]!.id, false);
  assert.equal(await other, false);
  await store.close();
});

test('concurrent disconnects and close clean each connection only once', async () => {
  const { store, connector, transports, accountId } = await connected();
  await Promise.all([store.disconnectAccount(accountId), store.disconnectAccount(accountId), store.close()]);
  assert.equal(connector.disconnected, 1);
  assert.equal(transports[0]!.closed, 1);
  assert.equal(store.getSnapshot().accounts[0]!.status, 'disconnected');
});

test('logout during failed setup cleanup cannot restore an error account', async () => {
  const cleaning = deferred();
  const release = deferred();
  const { store, connectors, transports } = harness(connector => {
    connector.onConnect = async () => { throw new Error('Synthetic setup failure'); };
    connector.onDisconnect = async () => { cleaning.resolve(); await release.promise; };
  });
  let failure: unknown;
  const connecting = store.connectAccount(input).catch(error => { failure = error; });
  await cleaning.promise;
  const disconnecting = store.disconnectAccount(store.getSnapshot().accounts[0]!.id);
  release.resolve();
  await Promise.all([connecting, disconnecting]);
  assert.equal(failure, undefined);
  assert.equal(store.getSnapshot().accounts[0]!.status, 'disconnected');
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(connectors[0]!.disconnected, 1);
  assert.equal(transports[0]!.closed, 1);
});

test('events queued before logout cannot change the disconnected workspace', async () => {
  const { store, connector, conversation, accountId } = await connected();
  await store.disconnectAccount(accountId);
  const before = store.getSnapshot();
  connector.context.emit({ type: 'message', message: incoming(conversation) });
  connector.context.emit({ type: 'typing', conversationId: conversation.id, names: ['Stale person'] });
  connector.context.emit({ type: 'error', message: 'Stale session failure' });
  assert.equal(store.getSnapshot(), before);
});

for (const body of ['', '   ', 'x'.repeat(20_001)]) {
  test(`invalid message length ${body.length} has no optimistic side effects`, async () => {
    const { store, connector, conversation } = await connected();
    const before = store.getSnapshot();
    await assert.rejects(store.sendMessage(conversation.id, body), /1 to 20,000/);
    assert.equal(store.getSnapshot(), before);
    assert.equal(connector.sent.length, 0);
    await store.close();
  });
}

test('maximum length text is trimmed once and submitted exactly once', async () => {
  const { store, connector, conversation } = await connected();
  await store.sendMessage(conversation.id, `  ${'x'.repeat(20_000)}  `);
  assert.equal(connector.sent.length, 1);
  assert.equal(connector.sent[0]!.body.length, 20_000);
  await store.close();
});

test('typing is account scoped and throttled without blocking another conversation', async () => {
  const { store, connector, accountId, conversation } = await connected();
  const second = chat(accountId, 'other');
  connector.context.emit({ type: 'conversation', conversation: second });
  store.setTyping(conversation.id);
  store.setTyping(conversation.id);
  store.setTyping(second.id);
  assert.deepEqual(connector.typed, [conversation.id, second.id]);
  await store.close();
});

test('a failed new conversation reports once and never retries the write', async () => {
  const { store, connector, accountId } = await connected();
  connector.onStart = async () => { throw new Error('Synthetic chat creation failure'); };
  await assert.rejects(store.startConversation(accountId, '  other@example.org  '), /connection could not complete/);
  assert.deepEqual(connector.started, ['other@example.org']);
  assert.equal(store.getSnapshot().notice?.kind, 'error');
  await store.close();
});

for (const provider of ['skype', 'teamwire'] as const) {
  for (const [label, server] of [['credentials', 'https://embedded:password@chat.example.org'], ['query', 'https://chat.example.org?token=synthetic-secret'], ['unencrypted HTTP', 'http://chat.example.org']]) {
    test(`${provider} rejects server ${label} without retaining the input`, async () => {
      const { store, connectors, transports } = harness();
      await assert.rejects(store.connectAccount({ ...input, provider, server }), /HTTPS/);
      assert.equal(store.getSnapshot().accounts.length, 0);
      assert.equal(connectors.length, 0);
      assert.equal(transports.length, 0);
      assert.doesNotMatch(JSON.stringify(store.getSnapshot()), /embedded:password|synthetic-secret/);
    });
  }
}
