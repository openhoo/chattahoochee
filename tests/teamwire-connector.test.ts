import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import test from 'node:test';
import { TeamwireConnector } from '../src/connectors/teamwire';
import { scopedId, type ConnectorContext, type ConnectorEvent } from '../src/connectors/types';
import { NativeAccountTransport, type Invoke } from '../src/lib/native-transport';
import { MessengerStore } from '../src/model/store';
import type { AppSnapshot, Conversation } from '../src/model/types';

const origin = 'https://messaging.example.test';
const threadKey = 'abcdefghijklmnopqrstuvwxyz123456';
const messageTime = '2026-01-02T03:04:05.678Z';

interface WireMessage {
  mid?: string; tid?: string; from: string; ts?: string; m?: string; cid?: string;
  type?: string; chats?: string[];
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

function encrypt(text: string, key: string): string {
  const iv = Buffer.alloc(16, 6);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  return Buffer.concat([iv, createHash('sha256').update(iv).digest(), cipher.update(text), cipher.final()]).toString('base64');
}

function decrypt(value: string, key: string): string {
  const bytes = Buffer.from(value, 'base64');
  assert.deepEqual(bytes.subarray(16, 48), createHash('sha256').update(bytes.subarray(0, 16)).digest());
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key), bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(48)), decipher.final()]).toString('utf8');
}

function message(id: string, from: string, text: string, extra: Partial<WireMessage> = {}): WireMessage {
  return { mid: id, tid: 'thread-1', from, ts: messageTime, m: encrypt(text, threadKey), ...extra };
}

interface SentMessage { cid: string; text: string; wire: WireMessage }
interface FixtureOptions {
  ownerId?: string;
  history?: WireMessage[];
  initialFeed?: WireMessage[];
  holdSend?: boolean;
  sendStatus?: number;
  missingKey?: boolean;
  chatVersion?: number;
  threadCount?: number;
  histories?: Record<string, WireMessage[]>;
  holdContacts?: boolean;
  holdHistory?: string;
  corruptContacts?: boolean;
  omitOwner?: boolean;
  liveCursor?: string;
  logoutStatus?: number;
}

/** Native AES and ECDH fixtures are independent of the SDK's implementations. */
class EncryptedTeamwireServer {
  readonly ownerId: string;
  readonly requests: Array<{ path: string; method: string; payload?: Record<string, unknown> }> = [];
  readonly sent = new Deferred<SentMessage>();
  readonly releaseSend = new Deferred<void>();
  readonly pollStarted = new Deferred<void>();
  readonly contactsStarted = new Deferred<void>();
  readonly releaseContacts = new Deferred<void>();
  readonly historyStarted = new Deferred<void>();
  readonly releaseHistory = new Deferred<void>();
  readonly sentMessages: SentMessage[] = [];
  readonly pollingSignals: AbortSignal[] = [];
  readonly activeRequests = new Map<string, AbortController>();
  readonly history: WireMessage[];
  private readonly ecdh = createECDH('secp256k1');
  private readonly queue: WireMessage[][] = [];
  private waiter?: Deferred<WireMessage[]>;
  private sessionKey = '';
  private feeds = 0;
  private readonly unsubscribed = new Set<string>();

  constructor(private readonly options: FixtureOptions = {}) {
    this.ownerId = options.ownerId ?? 'owner-1';
    this.history = options.history ?? [];
    this.ecdh.setPrivateKey(Buffer.alloc(32, 11));
  }

  enqueueFeed(messages: WireMessage[]): void {
    for (const row of messages) {
      for (const threadId of row.chats ?? []) {
        if (row.type === 'chats.leave') this.unsubscribed.add(threadId);
        if (row.type === 'chats.join') this.unsubscribed.delete(threadId);
      }
    }
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(messages); }
    else this.queue.push(messages);
  }

  private subscriptions(): unknown[] {
    return Array.from({ length: this.options.threadCount ?? 1 }, (_, index) => ({
      tid: `thread-${index + 1}`, ...(!this.options.missingKey ? { col: threadKey } : {}), chat_v: this.options.chatVersion ?? 0,
      thread_info: { type: '1to1', title: '', is_closed: false, allowSending: true, admins: [this.ownerId] },
      members: { users: [this.ownerId, 'person-2'], groups: [], roles: [] }, ts: new Date(Date.parse(messageTime) + index * 1000).toISOString(),
    })).filter(row => !this.unsubscribed.has(row.tid));
  }

  private encrypted(data: unknown, headers: HeadersInit = {}): Response {
    return new Response(encrypt(JSON.stringify(data), this.sessionKey), { headers });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin);
    const path = url.pathname + url.search;
    const headers = new Headers(init.headers);
    const entry: { path: string; method: string; payload?: Record<string, unknown> } = { path, method: init.method ?? 'GET' };
    this.requests.push(entry);
    if (path === '/v20/u/sessions/') {
      const body = JSON.parse(String(init.body));
      assert.match(body.client_pubkey, /^04[\da-f]{128}$/);
      this.sessionKey = this.ecdh.computeSecret(Buffer.from(body.client_pubkey, 'hex')).subarray(0, 24).toString('base64');
      return Response.json({ session_id: 'challenge', server_pubkey: this.ecdh.getPublicKey('hex', 'uncompressed') });
    }
    if (path === '/v20/u/login/challenge/') {
      const credentials = JSON.parse(decrypt(String(init.body), this.sessionKey));
      assert.equal(credentials.password, 'synthetic-password');
      return this.encrypted({ from_id: 'public-session', ...(!this.options.omitOwner ? { owner_id: this.ownerId } : {}) });
    }
    assert.equal(headers.get('From'), 'public-session');
    if (init.body) entry.payload = JSON.parse(decrypt(String(init.body), this.sessionKey));
    if (path === '/v20/contacts') {
      this.contactsStarted.resolve();
      if (this.options.holdContacts) await abortable(this.releaseContacts.promise, init.signal);
      if (this.options.corruptContacts) return new Response('invalid-encrypted-contact-envelope');
      return this.encrypted({ users: [
        { id: this.ownerId, first_name: 'Current', last_name: 'User' },
        { id: 'person-2', first_name: 'Alex', last_name: 'Example', profile: { email: 'alex@example.test' } },
      ] });
    }
    if (path === '/v20/u/subscriptions/?legacy_circle_ids=true') return this.encrypted(this.subscriptions());
    if (path === '/v20/u/subscriptions/matching_ids?legacy_circle_ids=true') return this.encrypted({ subscriptions: this.subscriptions() });
    const historyMatch = /^\/v20\/t\/(thread-\d+)\/$/.exec(path);
    if (historyMatch) {
      if (this.options.holdHistory === historyMatch[1]) {
        this.historyStarted.resolve();
        await abortable(this.releaseHistory.promise, init.signal);
      }
      return this.encrypted(this.options.histories?.[historyMatch[1]!] ?? (historyMatch[1] === 'thread-1' ? this.history : []));
    }
    if (path === '/v20/feed') {
      let rows: WireMessage[];
      if (this.feeds++ === 0) rows = this.options.initialFeed ?? [];
      else {
        if (init.signal) this.pollingSignals.push(init.signal);
        this.pollStarted.resolve();
        if (this.queue.length) rows = this.queue.shift()!;
        else { this.waiter = new Deferred<WireMessage[]>(); rows = await abortable(this.waiter.promise, init.signal); }
      }
      for (const row of rows) {
        for (const threadId of row.chats ?? []) {
          if (row.type === 'chats.leave') this.unsubscribed.add(threadId);
          if (row.type === 'chats.join') this.unsubscribed.delete(threadId);
        }
      }
      const cursor = this.feeds > 1 && this.options.liveCursor ? this.options.liveCursor : new Date(Date.parse(messageTime) + this.feeds).toISOString();
      return this.encrypted({ messages: rows, read_threads: [] }, { ETag: Buffer.from(cursor).toString('hex') });
    }
    if (path === '/v20/t') {
      const text = decrypt(String(entry.payload?.msg), threadKey);
      assert.deepEqual(entry.payload?.notification, { text: 'Encrypted message' });
      const cid = String(entry.payload?.cid);
      const wire = message(`native-send-${this.sentMessages.length + 1}`, this.ownerId, text, { cid, tid: String(entry.payload?.tid) });
      const sent = { cid, text, wire };
      this.sentMessages.push(sent);
      this.sent.resolve(sent);
      if (this.options.holdSend) await abortable(this.releaseSend.promise, init.signal);
      if (this.options.sendStatus) return new Response('Synthetic gateway failure', { status: this.options.sendStatus });
      return this.encrypted({ mid: wire.mid, tid: wire.tid, ts: wire.ts });
    }
    if (/^\/v20\/t\/thread-\d+\/readers$/.test(path)) return new Response(null, { status: 204 });
    if (path === '/v20/u/logout') return new Response('ok', { status: this.options.logoutStatus ?? 200 });
    throw new Error(`Unexpected fixture request ${path}`);
  };

  /** Exercise the actual NativeAccountTransport encoder and cancellation bridge. */
  readonly invoke: Invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (command === 'configure_account_transport') {
      assert.deepEqual(args.origins, [origin]);
      return undefined as T;
    }
    if (command === 'cancel_account_http') { this.activeRequests.get(String(args.requestId))?.abort(); return undefined as T; }
    if (command === 'remove_account_transport') {
      for (const controller of this.activeRequests.values()) controller.abort();
      return undefined as T;
    }
    assert.equal(command, 'account_http');
    const requestId = String(args.requestId);
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    try {
      const response = await this.fetch(String(args.url), {
        method: String(args.method), headers: args.headers as [string, string][],
        body: args.body === undefined ? undefined : Buffer.from(String(args.body), 'base64').toString('utf8'),
        signal: controller.signal,
      });
      return {
        status: response.status, headers: [...response.headers.entries()], url: String(args.url),
        body: Buffer.from(await response.arrayBuffer()).toString('base64'), bodyEncoding: 'base64',
      } as T;
    } finally { this.activeRequests.delete(requestId); }
  };
}

function fixtureStore(fixtures: EncryptedTeamwireServer[]) {
  const connectors: TeamwireConnector[] = [];
  let index = 0;
  const store = new MessengerStore({
    isDesktop: () => true,
    connectorFactory: () => { const connector = new TeamwireConnector(); connectors.push(connector); return connector; },
    transportFactory: accountId => new NativeAccountTransport(accountId, fixtures[index++]!.invoke),
  });
  return { store, connectors };
}

async function connect(store: MessengerStore, email = 'user@example.test'): Promise<Conversation> {
  await store.connectAccount({ provider: 'teamwire', address: email, password: 'synthetic-password', server: origin });
  return store.getSnapshot().conversations.at(-1)!;
}

async function changed(store: MessengerStore, predicate: (snapshot: AppSnapshot) => boolean): Promise<void> {
  if (predicate(store.getSnapshot())) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Expected connector state update did not arrive.')); }, 2000);
    const unsubscribe = store.subscribe(() => {
      if (predicate(store.getSnapshot())) { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  });
}

const input = { provider: 'teamwire' as const, address: 'user@example.test', password: 'synthetic-password', server: origin };

async function nativeContext(server: EncryptedTeamwireServer, accountId: string) {
  const transport = new NativeAccountTransport(accountId, server.invoke);
  await transport.allowOrigins([origin]);
  const controller = new AbortController();
  const events: ConnectorEvent[] = [];
  const context: ConnectorContext = {
    accountId, fetch: transport.fetch, signal: controller.signal,
    approveOrigin: async () => false, emit: event => { events.push(event); },
  };
  return { transport, controller, events, context };
}

test('Teamwire owner identity determines direction and native ids remain scoped per account', async t => {
  const first = new EncryptedTeamwireServer({ ownerId: 'owner-1', history: [message('same-id', 'owner-1', 'First account')] });
  const second = new EncryptedTeamwireServer({ ownerId: 'owner-2', history: [message('same-id', 'owner-2', 'Second account'), message('incoming', 'person-2', 'Hello')] });
  const { store } = fixtureStore([first, second]);
  t.after(() => store.close());
  const one = await connect(store, 'one@example.test');
  const two = await connect(store, 'two@example.test');
  assert.notEqual(one.id, two.id);
  assert.equal(one.title, 'Alex Example');
  assert.deepEqual(one.participants, ['Alex Example']);
  assert.equal(store.getSnapshot().messages[one.id]?.[0]?.direction, 'outgoing');
  assert.equal(store.getSnapshot().messages[two.id]?.find(row => row.body === 'Second account')?.senderName, 'You');
  assert.equal(store.getSnapshot().messages[two.id]?.find(row => row.body === 'Hello')?.direction, 'incoming');
  assert.notEqual(store.getSnapshot().messages[one.id]?.[0]?.id, store.getSnapshot().messages[two.id]?.[0]?.id);
  assert.equal(store.getSnapshot().messages[one.id]?.[0]?.delivery, 'accepted');
});

test('real connector decrypts history and renders explicit placeholders without leaking ciphertext', async t => {
  const server = new EncryptedTeamwireServer({ history: [
    message('good', 'person-2', 'Hello 👋'),
    message('bad', 'person-2', 'ignored', { m: 'invalid encrypted bytes' }),
    message('empty', 'person-2', '', { m: '' }),
    { mid: 'system', tid: 'thread-1', from: 'sys', ts: messageTime, type: 'mt_update' },
  ] });
  const { store, connectors } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await connectors[0]!.loadConversation(conversation);
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.id.endsWith('good'))?.body, 'Hello 👋');
  assert.equal(rows.find(row => row.id.endsWith('bad'))?.body, '[Encrypted message unavailable in this client]');
  assert.equal(rows.find(row => row.id.endsWith('empty'))?.body, '[Message with no supported text content]');
  assert.equal(JSON.stringify(rows).includes('invalid encrypted bytes'), false);
  assert.equal(server.requests.filter(row => row.path === '/v20/t/thread-1/').length, 1);
});

test('unsupported conversation encryption disables sending and displays an encrypted placeholder', async t => {
  const server = new EncryptedTeamwireServer({ chatVersion: 1, history: [message('new-format', 'person-2', 'Hidden text')] });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  assert.equal(conversation.capabilities.sendMessages, false);
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.body, '[Encrypted message unavailable in this client]');
  await assert.rejects(store.sendMessage(conversation.id, 'Example'), /Sending is unavailable/);
  assert.equal(server.requests.some(row => row.path === '/v20/t'), false);
});

test('send uses nested encryption and reconciles an echo arriving after the HTTP receipt', async t => {
  const server = new EncryptedTeamwireServer();
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await store.sendMessage(conversation.id, 'One logical message');
  const sent = await server.sent.promise;
  assert.equal(sent.text, 'One logical message');
  const echo = { ...sent.wire, cid: undefined, ts: '2026-01-02T03:04:06.000Z' };
  server.enqueueFeed([echo]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.some(row => row.createdAt === echo.ts) === true);
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, scopedId(conversation.accountId, sent.cid));
  assert.equal(rows[0]?.delivery, 'accepted');
  assert.equal(server.requests.filter(row => row.path === '/v20/t').length, 1);
});

test('a native echo arriving before its receipt is atomically reconciled with the optimistic message', async t => {
  const server = new EncryptedTeamwireServer({ holdSend: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  const sending = store.sendMessage(conversation.id, 'Echo before receipt');
  const sent = await server.sent.promise;
  server.enqueueFeed([{ ...sent.wire, cid: undefined }]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.some(row => row.id === scopedId(conversation.accountId, 'native-send-1')) === true);
  server.releaseSend.resolve();
  await sending;
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, scopedId(conversation.accountId, sent.cid));
  assert.equal(rows[0]?.delivery, 'accepted');
});

test('another sender cannot claim an outgoing correlation id', async t => {
  const server = new EncryptedTeamwireServer({ holdSend: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  const sending = store.sendMessage(conversation.id, 'Outgoing');
  const sent = await server.sent.promise;
  server.enqueueFeed([message('peer-message', 'person-2', 'Incoming', { cid: sent.cid })]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.some(row => row.body === 'Incoming') === true);
  server.releaseSend.resolve();
  await sending;
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.body === 'Incoming')?.id, scopedId(conversation.accountId, 'peer-message'));
  assert.equal(rows.find(row => row.body === 'Outgoing')?.id, scopedId(conversation.accountId, sent.cid));
});

test('an authenticated own echo resolves a previously uncertain failed send without duplicating it', async t => {
  const server = new EncryptedTeamwireServer({ sendStatus: 503 });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await assert.rejects(store.sendMessage(conversation.id, 'Uncertain outcome'));
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
  const sent = await server.sent.promise;
  server.enqueueFeed([sent.wire]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.[0]?.delivery === 'accepted');
  assert.equal(store.getSnapshot().messages[conversation.id]?.length, 1);
  assert.equal(server.requests.filter(row => row.path === '/v20/t').length, 1);
});

test('an own echo received before an HTTP failure keeps its confirmed acceptance', async t => {
  const server = new EncryptedTeamwireServer({ holdSend: true, sendStatus: 503 });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  const sending = store.sendMessage(conversation.id, 'Accepted despite gateway failure');
  const sent = await server.sent.promise;
  server.enqueueFeed([sent.wire]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.[0]?.delivery === 'accepted');
  server.releaseSend.resolve();
  await sending;
  assert.equal(store.getSnapshot().messages[conversation.id]?.length, 1);
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'accepted');
});

test('read markers use the newest incoming id and the current read time', async t => {
  const server = new EncryptedTeamwireServer({ history: [
    message('incoming-old', 'person-2', 'Old', { ts: '2026-01-01T00:00:00.000Z' }),
    message('incoming-new', 'person-2', 'New', { ts: '2026-01-02T00:00:00.000Z' }),
    message('outgoing-newest', 'owner-1', 'Own', { ts: '2026-01-03T00:00:00.000Z' }),
  ] });
  const { store, connectors } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  const start = Date.now();
  await connectors[0]!.markRead(conversation);
  const end = Date.now();
  const request = server.requests.find(row => row.path.endsWith('/readers'))!;
  assert.equal(request.payload?.mid, 'incoming-new');
  assert.ok(Number(request.payload?.mts) >= start && Number(request.payload?.mts) <= end);
});

test('an initial leave event disables historical conversation sending and reading', async t => {
  const server = new EncryptedTeamwireServer({
    history: [message('past', 'person-2', 'Historical message')],
    initialFeed: [{ from: 'sys', type: 'chats.leave', chats: ['thread-1'] }],
  });
  const { store, connectors } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  assert.equal(conversation.capabilities.sendMessages, false);
  assert.equal(conversation.capabilities.markRead, false);
  await assert.rejects(store.sendMessage(conversation.id, 'Should not send'));
  await connectors[0]!.markRead(conversation);
  assert.equal(server.requests.some(row => row.path.endsWith('/readers')), false);
  assert.equal(server.requests.some(row => row.path === '/v20/t/thread-1/'), false);
  await assert.rejects(connectors[0]!.sendMessage({ ...conversation, capabilities: { ...conversation.capabilities, sendMessages: true } }, 'Stale action', 'stale-operation'));
  assert.equal(server.requests.some(row => row.path === '/v20/t'), false);
});

test('a live leave event disables capabilities and preserves the historical timeline', async t => {
  const server = new EncryptedTeamwireServer({ history: [message('past', 'person-2', 'Historical message')] });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  server.enqueueFeed([{ from: 'sys', type: 'chats.leave', chats: ['thread-1'] }]);
  await changed(store, snapshot => snapshot.conversations.find(row => row.id === conversation.id)?.capabilities.sendMessages === false);
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.body, 'Historical message');
  assert.equal(store.getSnapshot().conversations.find(row => row.id === conversation.id)?.capabilities.markRead, false);
});

test('a later explicit join restores capabilities through a fresh subscription read', async t => {
  const server = new EncryptedTeamwireServer({ initialFeed: [{ from: 'sys', type: 'chats.leave', chats: ['thread-1'] }] });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  assert.equal(conversation.capabilities.sendMessages, false);
  await server.pollStarted.promise;
  server.enqueueFeed([{ from: 'sys', type: 'chats.join', chats: ['thread-1'] }]);
  await changed(store, snapshot => snapshot.conversations.find(row => row.id === conversation.id)?.capabilities.sendMessages === true);
  assert.equal(store.getSnapshot().conversations.find(row => row.id === conversation.id)?.capabilities.markRead, true);
  await store.sendMessage(conversation.id, 'Back in the conversation');
  assert.equal((await server.sent.promise).text, 'Back in the conversation');
});

test('disconnect cancels active native polling and disables account capabilities', async () => {
  const server = new EncryptedTeamwireServer();
  const { store } = fixtureStore([server]);
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await store.disconnectAccount(conversation.accountId);
  assert.ok(server.pollingSignals.some(signal => signal.aborted));
  assert.equal(server.activeRequests.size, 0);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(store.getSnapshot().conversations[0]?.capabilities.sendMessages, false);
  assert.equal(store.getSnapshot().notice?.kind === 'error', false);
});

test('disconnect cancels a pending encrypted send without fabricating acceptance', async t => {
  const server = new EncryptedTeamwireServer({ holdSend: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  const sending = store.sendMessage(conversation.id, 'Pending cancellation');
  const rejected = assert.rejects(sending);
  await server.sent.promise;
  await store.disconnectAccount(conversation.accountId);
  await rejected;
  assert.equal(store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
  assert.equal(server.requests.filter(row => row.path === '/v20/t').length, 1);
  assert.equal(server.activeRequests.size, 0);
});

test('an already cancelled connector performs no authentication request', async () => {
  const server = new EncryptedTeamwireServer();
  const controller = new AbortController();
  controller.abort();
  const connector = new TeamwireConnector();
  await assert.rejects(connector.connect({ provider: 'teamwire', address: 'user@example.test', password: 'synthetic-password', server: origin }, {
    accountId: 'cancelled', fetch: server.fetch, signal: controller.signal,
    approveOrigin: async () => false, emit: () => { throw new Error('Cancelled connections must not emit data.'); },
  }), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(server.requests.length, 0);
  await connector.disconnect();
});

test('unsafe full server URLs are rejected before any Teamwire authentication request', async t => {
  for (const serverUrl of [
    'https://embedded:password@messaging.example.test',
    'https://messaging.example.test/api',
    'https://messaging.example.test?unexpected=1',
    'https://messaging.example.test#fragment',
  ]) {
    await t.test(serverUrl, async () => {
      const server = new EncryptedTeamwireServer();
      const { store } = fixtureStore([server]);
      try {
        await assert.rejects(store.connectAccount({ ...input, server: serverUrl }), /HTTPS origin/);
        assert.equal(server.requests.length, 0);
        assert.equal(store.getSnapshot().accounts.length, 0);
        assert.equal(JSON.stringify(store.getSnapshot()).includes('embedded:password'), false);
      } finally { await store.close(); }
    });
  }
});

test('a connector can reconnect with a new native context after disconnect without retaining aliases or abort listeners', async t => {
  const first = new EncryptedTeamwireServer();
  const second = new EncryptedTeamwireServer({ ownerId: 'owner-2', history: [message('native-send-1', 'person-2', 'New account history')] });
  const old = await nativeContext(first, 'first-account');
  const next = await nativeContext(second, 'second-account');
  const connector = new TeamwireConnector();
  t.after(async () => {
    await connector.disconnect();
    await Promise.all([old.transport.close(), next.transport.close()]);
  });
  await connector.connect(input, old.context);
  const conversation = old.events.find((event): event is Extract<ConnectorEvent, { type: 'conversation' }> => event.type === 'conversation')!.conversation;
  await connector.sendMessage(conversation, 'Old account message', 'old-operation');
  await connector.disconnect();
  const oldEventCount = old.events.length;
  await connector.connect(input, next.context);
  await second.pollStarted.promise;
  old.controller.abort();
  const received = next.events.find((event): event is Extract<ConnectorEvent, { type: 'message' }> => event.type === 'message')!.message;
  assert.equal(received.id, scopedId('second-account', 'native-send-1'));
  assert.equal(received.direction, 'incoming');
  const newConversation = next.events.find((event): event is Extract<ConnectorEvent, { type: 'conversation' }> => event.type === 'conversation')!.conversation;
  await connector.sendMessage(newConversation, 'Fresh connection', 'new-operation');
  assert.equal((await second.sent.promise).text, 'Fresh connection');
  assert.equal(old.events.length, oldEventCount);
  assert.equal(first.activeRequests.size, 0);
});

test('duplicate concurrent and active connects cannot replace the original Teamwire session', async t => {
  const first = new EncryptedTeamwireServer({ holdContacts: true });
  const second = new EncryptedTeamwireServer();
  const old = await nativeContext(first, 'original');
  const next = await nativeContext(second, 'unwanted');
  const connector = new TeamwireConnector();
  t.after(async () => {
    first.releaseContacts.resolve();
    await connector.disconnect();
    await Promise.all([old.transport.close(), next.transport.close()]);
  });
  const connecting = connector.connect(input, old.context);
  void connecting.catch(() => {});
  await first.contactsStarted.promise;
  await assert.rejects(connector.connect(input, next.context), /already|disconnect/i);
  assert.equal(second.requests.length, 0);
  first.releaseContacts.resolve();
  await connecting;
  await assert.rejects(connector.connect(input, next.context), /already|disconnect/i);
  assert.equal(second.requests.length, 0);
  assert.equal(old.events.some(event => event.type === 'conversation'), true);
  assert.equal(next.events.length, 0);
});

test('an account with no subscriptions connects and polls without issuing history or read requests', async t => {
  const server = new EncryptedTeamwireServer({ threadCount: 0 });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  await store.connectAccount(input);
  await server.pollStarted.promise;
  assert.equal(store.getSnapshot().accounts[0]?.status, 'connected');
  assert.equal(store.getSnapshot().contacts.length, 2);
  assert.equal(store.getSnapshot().conversations.length, 0);
  assert.equal(server.requests.some(request => /^\/v20\/t\//.test(request.path)), false);
  await store.disconnectAccount(store.getSnapshot().accounts[0]!.id);
  assert.equal(server.activeRequests.size, 0);
});

test('only the newest eight histories load eagerly and repeated lazy opens share one encrypted native read', async t => {
  const server = new EncryptedTeamwireServer({ threadCount: 12, holdHistory: 'thread-1', history: [message('oldest-chat', 'person-2', 'Lazy decrypted history')] });
  const { store, connectors } = fixtureStore([server]);
  t.after(() => store.close());
  await connect(store);
  const eager = server.requests.filter(request => /^\/v20\/t\/thread-\d+\/$/.test(request.path)).map(request => request.path).sort();
  assert.deepEqual(eager, [5, 6, 7, 8, 9, 10, 11, 12].map(id => `/v20/t/thread-${id}/`).sort());
  const oldest = store.getSnapshot().conversations.find(conversation => conversation.nativeId === 'thread-1')!;
  store.selectConversation(oldest.id);
  const one = connectors[0]!.loadConversation(oldest);
  const two = connectors[0]!.loadConversation(oldest);
  await server.historyStarted.promise;
  assert.equal(server.requests.filter(request => request.path === '/v20/t/thread-1/').length, 1);
  server.releaseHistory.resolve();
  await Promise.all([one, two]);
  assert.equal(store.getSnapshot().messages[oldest.id]?.[0]?.body, 'Lazy decrypted history');
  assert.equal(store.getSnapshot().messages[oldest.id]?.length, 1);
});

test('malformed contact encryption fails connection cleanly without publishing ciphertext or leaking native requests', async t => {
  const server = new EncryptedTeamwireServer({ corruptContacts: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  await assert.rejects(store.connectAccount(input));
  assert.equal(store.getSnapshot().accounts[0]?.status, 'error');
  assert.equal(store.getSnapshot().contacts.length, 0);
  assert.equal(store.getSnapshot().conversations.length, 0);
  assert.equal(server.activeRequests.size, 0);
  assert.equal(server.requests.some(request => request.path === '/v20/u/logout'), true);
  const published = JSON.stringify(store.getSnapshot());
  assert.equal(published.includes('invalid-encrypted-contact-envelope'), false);
  assert.equal(published.includes('synthetic-password'), false);
});

test('a missing human owner identity is rejected through the full account connection path', async t => {
  const server = new EncryptedTeamwireServer({ omitOwner: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  await assert.rejects(store.connectAccount(input));
  assert.equal(store.getSnapshot().accounts[0]?.status, 'error');
  assert.equal(store.getSnapshot().conversations.length, 0);
  assert.equal(server.requests.length, 2);
  assert.equal(server.activeRequests.size, 0);
});

test('a malformed live synchronization cursor stops the session and prevents subsequent native sends', async t => {
  const server = new EncryptedTeamwireServer({ liveCursor: '2026-02-30T03:04:05.000Z' });
  const { store, connectors } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  server.enqueueFeed([]);
  await changed(store, snapshot => snapshot.accounts[0]?.status === 'error');
  const count = server.requests.length;
  await assert.rejects(connectors[0]!.sendMessage(conversation, 'Cannot send after sync failure', 'after-failure'));
  assert.equal(server.requests.length, count);
  assert.match(store.getSnapshot().notice?.message ?? '', /synchronization stopped/i);
});

test('server logout failure still disconnects the account and closes all native requests', async () => {
  const server = new EncryptedTeamwireServer({ logoutStatus: 503 });
  const { store } = fixtureStore([server]);
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await store.disconnectAccount(conversation.accountId);
  assert.equal(server.activeRequests.size, 0);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(store.getSnapshot().conversations[0]?.capabilities.sendMessages, false);
  assert.equal(store.getSnapshot().notice?.kind, 'info');
  assert.match(store.getSnapshot().notice?.message ?? '', /logout could not be confirmed/);
  assert.equal(server.requests.filter(request => request.path === '/v20/u/logout').length, 1);
});

test('existing conversations open with case insensitive email matching and hostile recipients issue no requests', async t => {
  const server = new EncryptedTeamwireServer();
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await store.startConversation(conversation.accountId, 'ALEX@EXAMPLE.TEST');
  assert.equal(store.getSnapshot().selectedConversationId, conversation.id);
  const requestCount = server.requests.length;
  await assert.rejects(store.startConversation(conversation.accountId, 'https://untrusted.example.test/leak?secret=value'), /existing Teamwire chats/);
  assert.equal(server.requests.length, requestCount);
  assert.equal(server.requests.some(request => request.method === 'POST' && request.path === '/v20/t'), false);
});

test('initial feed, history and a repeated live event keep one logical incoming message', async t => {
  const row = message('same-logical-message', 'person-2', 'A single timeline row');
  const server = new EncryptedTeamwireServer({ initialFeed: [row], history: [row] });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  assert.equal(store.getSnapshot().messages[conversation.id]?.length, 1);
  await server.pollStarted.promise;
  server.enqueueFeed([{ ...row, ts: '2026-01-02T03:04:06.000Z' }]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.[0]?.createdAt === '2026-01-02T03:04:06.000Z');
  assert.equal(store.getSnapshot().messages[conversation.id]?.length, 1);
  assert.equal(store.getSnapshot().conversations[0]?.unread, 0);
});

test('concurrent encrypted sends and a reversed echo batch retain unique messages and correlation ids', async t => {
  const server = new EncryptedTeamwireServer();
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.sendMessage(conversation.id, `Parallel message ${index}`)));
  assert.equal(new Set(server.sentMessages.map(sent => sent.cid)).size, 12);
  assert.equal(new Set(server.sentMessages.map(sent => sent.wire.mid)).size, 12);
  server.enqueueFeed([...server.sentMessages].reverse().map(sent => ({ ...sent.wire, cid: undefined, ts: '2026-01-02T03:04:07.000Z' })));
  await changed(store, snapshot => snapshot.messages[conversation.id]?.every(row => row.createdAt === '2026-01-02T03:04:07.000Z') === true);
  const messages = store.getSnapshot().messages[conversation.id]!;
  assert.equal(messages.length, 12);
  assert.equal(new Set(messages.map(row => row.body)).size, 12);
  assert.equal(messages.every(row => row.delivery === 'accepted'), true);
  assert.equal(server.requests.filter(request => request.path === '/v20/t').length, 12);
});

test('an incoming sender cannot inherit an accepted outgoing alias by reusing its native id', async t => {
  const server = new EncryptedTeamwireServer();
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  await store.sendMessage(conversation.id, 'Confirmed own message');
  const sent = await server.sent.promise;
  server.enqueueFeed([message(sent.wire.mid!, 'person-2', 'Different sender', { cid: sent.cid })]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.some(row => row.body === 'Different sender') === true);
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.body === 'Confirmed own message')?.id, scopedId(conversation.accountId, sent.cid));
  assert.equal(rows.find(row => row.body === 'Different sender')?.direction, 'incoming');
});

test('an outgoing alias cannot cross conversation boundaries even when a native id is reused', async t => {
  const server = new EncryptedTeamwireServer({ threadCount: 2 });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  await connect(store);
  const first = store.getSnapshot().conversations.find(conversation => conversation.nativeId === 'thread-1')!;
  const second = store.getSnapshot().conversations.find(conversation => conversation.nativeId === 'thread-2')!;
  await server.pollStarted.promise;
  await store.sendMessage(first.id, 'First conversation');
  const sent = await server.sent.promise;
  server.enqueueFeed([message(sent.wire.mid!, 'owner-1', 'Second conversation', { tid: second.nativeId, cid: sent.cid })]);
  await changed(store, snapshot => snapshot.messages[second.id]?.length === 1);
  assert.equal(store.getSnapshot().messages[second.id]?.[0]?.id, scopedId(second.accountId, sent.wire.mid!));
  assert.notEqual(store.getSnapshot().messages[first.id]?.[0]?.id, store.getSnapshot().messages[second.id]?.[0]?.id);
});

test('an outgoing receipt cannot delete an incoming row that reused its native id before acceptance', async t => {
  const server = new EncryptedTeamwireServer({ holdSend: true });
  const { store } = fixtureStore([server]);
  t.after(() => store.close());
  const conversation = await connect(store);
  await server.pollStarted.promise;
  const sending = store.sendMessage(conversation.id, 'Own pending message');
  const sent = await server.sent.promise;
  server.enqueueFeed([message(sent.wire.mid!, 'person-2', 'Incoming while pending')]);
  await changed(store, snapshot => snapshot.messages[conversation.id]?.some(row => row.body === 'Incoming while pending') === true);
  server.releaseSend.resolve();
  await sending;
  const rows = store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.body === 'Incoming while pending')?.direction, 'incoming');
  assert.equal(rows.find(row => row.body === 'Own pending message')?.delivery, 'accepted');
});

test('disconnect during encrypted contacts loading leaves the account disconnected and cancels native initialization', async () => {
  const server = new EncryptedTeamwireServer({ holdContacts: true });
  const { store } = fixtureStore([server]);
  const connecting = store.connectAccount(input);
  await server.contactsStarted.promise;
  const accountId = store.getSnapshot().accounts[0]!.id;
  await store.disconnectAccount(accountId);
  await connecting;
  assert.equal(server.activeRequests.size, 0);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(store.getSnapshot().contacts.length, 0);
  assert.equal(store.getSnapshot().notice?.kind === 'error', false);
});

test('disconnect during an eager history read cannot resurrect messages or account capabilities', async () => {
  const server = new EncryptedTeamwireServer({ holdHistory: 'thread-1', history: [message('not-published', 'person-2', 'Pending private history')] });
  const { store } = fixtureStore([server]);
  const connecting = store.connectAccount(input);
  await server.historyStarted.promise;
  const accountId = store.getSnapshot().accounts[0]!.id;
  await store.disconnectAccount(accountId);
  await connecting;
  server.releaseHistory.resolve();
  assert.equal(server.activeRequests.size, 0);
  assert.equal(store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(store.getSnapshot().conversations[0]?.capabilities.sendMessages, false);
  assert.equal(Object.values(store.getSnapshot().messages).flat().some(row => row.body === 'Pending private history'), false);
});
