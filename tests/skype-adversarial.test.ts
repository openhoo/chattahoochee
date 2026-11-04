import assert from 'node:assert/strict';
import test from 'node:test';
import type { UcwaEventBatch, UcwaResource } from 'skypeforhoo';
import { SkypeConnector } from '../src/connectors/skype';
import { scopedId } from '../src/connectors/types';
import { NativeAccountTransport, type Invoke } from '../src/lib/native-transport';
import { MessengerStore } from '../src/model/store';
import type { AccountInput, AppSnapshot, Conversation } from '../src/model/types';

const discovery = 'https://lyncdiscover.example.test/';
const internal = 'https://lyncdiscoverinternal.example.test/';
const pool = 'https://pool.example.test';
const issuer = 'https://identity.example.test';
const registration = `${pool}/registrations/synthetic-client`;
const primary = `${pool}/chats/primary`;
const secondary = `${pool}/chats/secondary`;
const timestamp = '2026-01-02T03:04:05.678Z';
const password = 'synthetic-password';
const login = 'EXAMPLE\\separate.login';
const token = 'synthetic-access-token';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Synthetic Skype fixture did not observe ${label}.`);
}

interface Call { url: string; method: string; headers: Headers; body?: string; signal: AbortSignal }
interface Send { operationId: string; conversation: string; body: string; nativeUrl: string }
interface FixtureOptions {
  intercept?: (call: Call) => Response | undefined | Promise<Response | undefined>;
  challenge?: string;
  holdSend?: boolean;
  sendStatus?: number;
  sendLocation?: boolean;
  conversations?: string[];
  messaging?: 'send-and-type' | 'read-only';
}

/** Every request passes through the real SDK, native Fetch adapter and store. No network is used. */
class SyntheticSkypeServer {
  readonly calls: Call[] = [];
  readonly configurations: string[][] = [];
  readonly activeRequests = new Map<string, AbortController>();
  readonly sends: Send[] = [];
  readonly sendStarted = new Deferred<Send>();
  readonly releaseSend = new Deferred<void>();
  removed = 0;
  cancelled = 0;
  private accountId?: string;
  private origins = new Set<string>();
  private queue: UcwaResource[] = [];
  private poll?: Deferred<UcwaResource>;
  private sequence = 0;

  constructor(readonly options: FixtureOptions = {}) {}

  push(batch: UcwaEventBatch): number {
    const sequence = ++this.sequence;
    const data = { ...batch, _links: { ...batch._links, next: { href: `/event-queue?after=${sequence}&opaque=preserved` } } };
    if (this.poll) { const poll = this.poll; this.poll = undefined; poll.resolve(data); }
    else this.queue.push(data);
    return sequence;
  }

  async publish(batch: UcwaEventBatch): Promise<void> {
    const sequence = this.push(batch);
    await until(() => this.calls.find(call => new URL(call.url).searchParams.get('after') === String(sequence)), 'acknowledged event batch');
  }

  conversation(url: string): UcwaResource {
    return {
      subject: url === primary ? 'Primary chat' : 'Secondary chat', participantCount: 2, created: timestamp,
      _links: { self: { href: url }, messaging: { href: `${url}/messaging` } },
      _embedded: { participant: [{ name: 'Alex Example', uri: 'sip:alex@example.test' }, { name: 'Synthetic User', local: true }] },
    };
  }

  message(conversation: string, nativeUrl: string, fields: UcwaResource, status?: string): UcwaEventBatch {
    return { sender: [{ rel: 'conversation', href: conversation, events: [{
      type: 'completed', ...(status ? { status } : {}), link: { rel: 'message', href: nativeUrl },
      _embedded: { message: { timeStamp: timestamp, ...fields, _links: { self: { href: nativeUrl }, ...fields._links } } },
    }] }] };
  }

  private async respond(call: Call): Promise<Response> {
    const { url, method, headers, signal } = call;
    signal.throwIfAborted();
    const intercepted = await this.options.intercept?.(call);
    if (intercepted) return intercepted;
    if ([discovery, internal].includes(url)) {
      assert.equal(headers.has('authorization'), false, 'Discovery must not carry a cached bearer token');
      assert.equal(call.body, undefined);
      return Response.json({ _links: { user: { href: `${pool}/discovery/user` } } });
    }
    if (url === `${issuer}/tokens/password`) {
      const form = new URLSearchParams(call.body);
      assert.equal(form.get('username'), login);
      assert.equal(form.get('password'), password);
      assert.equal(form.get('grant_type'), 'password');
      assert.equal(headers.has('authorization'), false);
      return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal((call.body ?? '').includes(password), false, 'Only the approved token issuer receives the password');
    if (url === `${pool}/discovery/user`) {
      if (!headers.has('authorization')) return new Response(null, { status: 401, headers: {
        'WWW-Authenticate': this.options.challenge ?? `MsRtcOAuth href="${issuer}/tokens/password", grant_type="password"`,
      } });
      return Response.json({ _links: { applications: { href: '/registrations/collection' } } });
    }
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    if (url === `${pool}/registrations/collection`) {
      assert.equal(method, 'POST');
      return Response.json({ _links: {
        self: { href: registration }, events: { href: '/event-queue?after=initial' },
        me: { href: '/hubs/me' }, people: { href: '/hubs/people' }, communication: { href: '/hubs/communication' },
      }, _embedded: { me: { _links: { makeMeAvailable: { href: '/operations/available' } } } } }, { status: 201 });
    }
    if (new URL(url).pathname === '/event-queue') {
      if (this.queue.length) return Response.json(this.queue.shift());
      this.poll = new Deferred<UcwaResource>();
      try { return Response.json(await abortable(this.poll.promise, signal)); }
      finally { this.poll = undefined; }
    }
    if (url === `${pool}/operations/available`) return new Response(null, { status: 204 });
    if (url === `${pool}/hubs/people`) return Response.json({ _links: { myContacts: { href: '/contacts/mine' } } });
    if (url === `${pool}/contacts/mine`) return Response.json({ _embedded: { contact: [{
      name: 'Alex Example', uri: 'sip:alex@example.test', _links: { self: { href: '/contacts/alex' } },
    }] } });
    if (url === `${pool}/hubs/communication`) return Response.json({ _links: {
      conversations: { href: '/chats/index' }, startMessaging: { href: '/operations/invite' },
    } });
    if (url === `${pool}/chats/index`) return Response.json({ _embedded: {
      conversation: (this.options.conversations ?? [primary, secondary]).map(url => this.conversation(url)),
    } });
    if ([primary, secondary].includes(url)) return Response.json(this.conversation(url));
    if ([`${primary}/messaging`, `${secondary}/messaging`].includes(url)) {
      const name = url === `${primary}/messaging` ? 'primary' : 'secondary';
      return Response.json({ _links: this.options.messaging === 'read-only' ? { self: { href: url } } : {
        self: { href: url }, sendMessage: { href: `/operations/send/${name}?keep=opaque` }, setIsTyping: { href: `/operations/typing/${name}` },
      } });
    }
    if (new URL(url).pathname.startsWith('/operations/send/')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('keep'), 'opaque');
      const operationId = parsed.searchParams.get('operationId')!;
      const send = { operationId, conversation: parsed.pathname.endsWith('/primary') ? primary : secondary, body: call.body!, nativeUrl: `${pool}/messages/${operationId}` };
      this.sends.push(send);
      this.sendStarted.resolve(send);
      if (this.options.holdSend) await abortable(this.releaseSend.promise, signal);
      if (this.options.sendStatus) return new Response(`Synthetic rejected request: ${password}`, { status: this.options.sendStatus });
      return new Response(null, { status: 201, headers: this.options.sendLocation === false ? {} : { location: send.nativeUrl } });
    }
    if (new URL(url).pathname.startsWith('/operations/typing/')) return new Response(null, { status: 204 });
    if (url === `${pool}/operations/invite`) return new Response(null, { status: 201, headers: { location: '/invitations/outgoing' } });
    if (url === registration && method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail(`Unexpected synthetic Skype request: ${method} ${url}`);
  }

  readonly invoke: Invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    this.accountId ??= String(args.accountId);
    assert.equal(args.accountId, this.accountId);
    if (command === 'configure_account_transport') {
      this.configurations.push(args.origins as string[]);
      this.origins = new Set(args.origins as string[]);
      return undefined as T;
    }
    if (command === 'cancel_account_http') { this.cancelled += 1; this.activeRequests.get(String(args.requestId))?.abort(); return undefined as T; }
    if (command === 'remove_account_transport') {
      this.removed += 1;
      this.origins.clear();
      for (const controller of this.activeRequests.values()) controller.abort();
      return undefined as T;
    }
    assert.equal(command, 'account_http');
    assert.ok(this.origins.has(new URL(String(args.url)).origin), 'Native request stays inside the approved account scope');
    const controller = new AbortController();
    const requestId = String(args.requestId);
    this.activeRequests.set(requestId, controller);
    const call: Call = {
      url: String(args.url), method: String(args.method), headers: new Headers(args.headers as [string, string][]),
      ...(args.body === undefined ? {} : { body: Buffer.from(String(args.body), 'base64').toString('utf8') }), signal: controller.signal,
    };
    this.calls.push(call);
    try {
      const response = await this.respond(call);
      return { status: response.status, headers: [...response.headers.entries()], url: call.url,
        body: Buffer.from(await response.arrayBuffer()).toString('base64'), bodyEncoding: 'base64' } as T;
    } finally { this.activeRequests.delete(requestId); }
  };
}

function fixture(server = new SyntheticSkypeServer()) {
  const connectors: SkypeConnector[] = [];
  const store = new MessengerStore({
    isDesktop: () => true,
    connectorFactory: () => { const connector = new SkypeConnector(); connectors.push(connector); return connector; },
    transportFactory: accountId => new NativeAccountTransport(accountId, server.invoke),
  });
  const input: AccountInput = { provider: 'skype', address: 'user@example.test', loginUsername: login, password, server: discovery, trustedOrigins: [pool, issuer] };
  const connect = async (overrides: Partial<AccountInput> = {}): Promise<Conversation> => {
    await store.connectAccount({ ...input, ...overrides });
    return store.getSnapshot().conversations.find(row => row.nativeId === primary)!;
  };
  return { store, server, connectors, connect, input };
}

function notice(snapshot: AppSnapshot): string { return `${snapshot.notice?.message ?? ''} ${snapshot.accounts[0]?.error ?? ''}`; }

test('default discovery falls back after native DNS failure and uses the separate login through the bridge', async t => {
  const app = fixture(new SyntheticSkypeServer({ intercept: call => {
    if (call.url === internal) throw { code: 'connection_failed', message: 'Synthetic DNS failure' };
    return undefined;
  } }));
  t.after(() => app.store.close());
  const conversation = await app.connect({ server: undefined });
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'connected');
  assert.equal(conversation.capabilities.sendMessages, true);
  assert.deepEqual(app.server.calls.slice(0, 2).map(call => call.url), [internal, discovery]);
  assert.equal(app.server.calls.filter(call => call.url === `${issuer}/tokens/password`).length, 1);
  assert.equal(app.server.configurations[0]?.includes(new URL(internal).origin), true);
  assert.equal(JSON.stringify(app.store.getSnapshot()).includes(password), false);
  assert.equal(JSON.stringify(app.store.getSnapshot()).includes(token), false);
});

test('declining the discovered pool prevents authentication and removes native account scope', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const connecting = app.connect({ trustedOrigins: [] });
  const approval = await until(() => app.store.getSnapshot().originApprovals[0], 'pool approval');
  assert.equal(approval.origin, pool);
  app.store.approveOrigin(approval.id, false);
  await assert.rejects(connecting, /not approved/);
  assert.deepEqual(app.server.calls.map(call => call.url), [discovery]);
  assert.equal(app.server.removed, 1);
  assert.equal(app.store.getSnapshot().originApprovals.length, 0);
});

test('declining the token issuer never sends the password to that origin', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const connecting = app.connect({ trustedOrigins: [pool] });
  const approval = await until(() => app.store.getSnapshot().originApprovals[0], 'issuer approval');
  assert.equal(approval.origin, issuer);
  app.store.approveOrigin(approval.id, false);
  await assert.rejects(connecting, /not approved/);
  assert.equal(app.server.calls.some(call => call.url.startsWith(issuer)), false);
  assert.equal(app.server.calls.some(call => call.body?.includes(password)), false);
});

test('unsupported authentication challenges fail without disclosing or attempting the password grant', async t => {
  const app = fixture(new SyntheticSkypeServer({ challenge: 'Negotiate, NTLM, Bearer authorization_uri="https://identity.example.test/federated"' }));
  t.after(() => app.store.close());
  await assert.rejects(app.connect());
  assert.equal(app.server.calls.some(call => call.url.startsWith(issuer)), false);
  assert.equal(app.server.calls.some(call => call.url === discovery && call.headers.has('authorization')), false);
  assert.equal(notice(app.store.getSnapshot()).includes('authorization_uri'), false);
  assert.equal(app.server.removed, 1);
});

test('token issuer error bodies remain absent from account state and notices', async t => {
  const app = fixture(new SyntheticSkypeServer({ intercept: call => call.url === `${issuer}/tokens/password`
    ? Response.json({ error_description: `Synthetic rejected ${login} ${password} ${token}` }, { status: 401 }) : undefined }));
  t.after(() => app.store.close());
  await assert.rejects(app.connect());
  const snapshot = JSON.stringify(app.store.getSnapshot());
  for (const secret of [password, token, login, 'error_description']) assert.equal(snapshot.includes(secret), false);
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'error');
  assert.equal(app.server.calls.some(call => call.url === `${pool}/registrations/collection`), false);
});

test('malformed OAuth JSON and unexpected token types fail before application registration', async t => {
  for (const [name, response] of [
    ['malformed JSON', () => new Response('{bad-json', { headers: { 'content-type': 'application/json' } })],
    ['unsupported token type', () => Response.json({ access_token: token, token_type: 'Basic' })],
  ] as const) {
    await t.test(name, async t => {
      const app = fixture(new SyntheticSkypeServer({ intercept: call => call.url === `${issuer}/tokens/password` ? response() : undefined }));
      t.after(() => app.store.close());
      await assert.rejects(app.connect());
      assert.equal(app.server.calls.some(call => call.url === `${pool}/registrations/collection`), false);
      assert.equal(app.server.removed, 1);
    });
  }
});

test('malformed discovery JSON fails without authenticating or silently trying a different identity', async t => {
  const app = fixture(new SyntheticSkypeServer({ intercept: call => [internal, discovery].includes(call.url)
    ? new Response('{bad', { headers: { 'content-type': 'application/json' } }) : undefined }));
  t.after(() => app.store.close());
  await assert.rejects(app.connect({ server: undefined }));
  assert.deepEqual(app.server.calls.map(call => call.url), [internal]);
  assert.equal(app.server.removed, 1);
});

test('an event completion from another chat cannot borrow a pending operation identity', async t => {
  const app = fixture(new SyntheticSkypeServer({ holdSend: true }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const sending = app.store.sendMessage(conversation.id, 'Private primary text');
  void sending.catch(() => {});
  const send = await app.server.sendStarted.promise;
  const foreignNative = `${pool}/messages/foreign-chat`;
  await app.server.publish(app.server.message(secondary, foreignNative, {
    direction: 'Outgoing', operationId: send.operationId, plainMessage: 'Different secondary text',
  }, 'Success'));
  const secondId = scopedId(conversation.accountId, secondary);
  const primaryId = scopedId(conversation.accountId, send.operationId);
  const foreign = app.store.getSnapshot().messages[secondId]?.[0];
  assert.equal(foreign?.id, scopedId(conversation.accountId, foreignNative));
  assert.notEqual(foreign?.id, primaryId);
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.body, 'Private primary text');
  app.server.releaseSend.resolve();
  await sending;
});

test('native message aliases cannot transfer a completion into another conversation', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.store.sendMessage(conversation.id, 'Primary text');
  const send = app.server.sends[0]!;
  await app.server.publish(app.server.message(secondary, send.nativeUrl, { direction: 'Outgoing', plainMessage: 'Secondary message' }, 'Failure'));
  const secondId = scopedId(conversation.accountId, secondary);
  assert.equal(app.store.getSnapshot().messages[secondId]?.[0]?.id, scopedId(conversation.accountId, send.nativeUrl));
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'accepted');
});

test('an early completion from a different chat cannot determine the receipt status of this send', async t => {
  const app = fixture(new SyntheticSkypeServer({ holdSend: true }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const sending = app.store.sendMessage(conversation.id, 'Primary accepted content');
  void sending.catch(() => {});
  const send = await app.server.sendStarted.promise;
  await app.server.publish(app.server.message(secondary, send.nativeUrl, { direction: 'Outgoing', plainMessage: 'Foreign failure' }, 'Failure'));
  app.server.releaseSend.resolve();
  await sending;
  const rows = app.store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.body, 'Primary accepted content');
  assert.equal(rows[0]?.delivery, 'accepted');
});

test('sending rejects a foreign account before native IPC and creates no server operation', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const before = app.server.calls.length;
  await assert.rejects(app.connectors[0]!.sendMessage({ ...conversation, accountId: 'another-account' }, 'Not sent', 'foreign-operation'), /belong/);
  assert.equal(app.server.calls.length, before);
  assert.equal(app.server.sends.length, 0);
});

test('typing rejects a conversation belonging to another account before native IPC', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const before = app.server.calls.length;
  await assert.rejects(app.connectors[0]!.setTyping({ ...conversation, accountId: 'different-account' }), /belong/);
  assert.equal(app.server.calls.length, before);
});

test('deleted Skype conversations disable composing and clear typing in visible store state', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.server.publish({ sender: [{ rel: 'conversation', href: primary, events: [{ type: 'updated', link: { rel: 'typingParticipants', href: '/typing/primary' },
    _embedded: { typingParticipants: { _embedded: { participant: [{ name: 'Alex Example' }] } } },
  }] }] });
  assert.deepEqual(app.store.getSnapshot().typing[conversation.id], ['Alex Example']);
  await app.server.publish({ sender: [{ rel: 'communication', events: [{ type: 'deleted', link: { rel: 'conversation', href: primary } }] }] });
  const closed = app.store.getSnapshot().conversations.find(row => row.id === conversation.id)!;
  assert.equal(closed.capabilities.sendMessages, false);
  assert.equal(closed.capabilities.typing, false);
  assert.deepEqual(app.store.getSnapshot().typing[conversation.id] ?? [], []);
  const before = app.server.calls.length;
  await assert.rejects(app.store.sendMessage(conversation.id, 'Cannot send to a deleted chat'), /unavailable/);
  assert.equal(app.server.calls.length, before);
});

test('late messages do not reenable a deleted conversation; an advertised rejoin does', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.server.publish({ sender: [{ events: [{ type: 'deleted', link: { rel: 'conversation', href: primary } }] }] });
  await app.server.publish(app.server.message(primary, `${pool}/messages/late`, { direction: 'Incoming', plainMessage: 'Late content' }));
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.body, 'Late content');
  assert.equal(app.store.getSnapshot().conversations.find(row => row.id === conversation.id)?.capabilities.sendMessages, false);
  await app.server.publish({ sender: [{ events: [{ type: 'added', link: { rel: 'conversation', href: primary }, _embedded: { conversation: app.server.conversation(primary) } }] }] });
  assert.equal(app.store.getSnapshot().conversations.find(row => row.id === conversation.id)?.capabilities.sendMessages, true);
});

test('replayed incoming events preserve one message and increment unread once', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const batch = app.server.message(secondary, `${pool}/messages/incoming`, { direction: 'Incoming', plainMessage: 'Hello once 👋' });
  await app.server.publish(batch);
  await app.server.publish(batch);
  const second = app.store.getSnapshot().conversations.find(row => row.nativeId === secondary)!;
  assert.notEqual(app.store.getSnapshot().selectedConversationId, second.id);
  assert.equal(app.store.getSnapshot().messages[second.id]?.length, 1);
  assert.equal(second.unread, 1);
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.length ?? 0, 0);
});

test('a success event arriving before an HTTP failure retains one delivered optimistic message', async t => {
  const app = fixture(new SyntheticSkypeServer({ holdSend: true, sendStatus: 502 }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const sending = app.store.sendMessage(conversation.id, 'Delivered before proxy error');
  const send = await app.server.sendStarted.promise;
  await app.server.publish(app.server.message(primary, send.nativeUrl, { direction: 'Outgoing', operationId: send.operationId }, 'Success'));
  app.server.releaseSend.resolve();
  await sending;
  const rows = app.store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.body, 'Delivered before proxy error');
  assert.equal(rows[0]?.delivery, 'delivered');
  assert.equal(rows[0]?.error, undefined);
});

test('completion with operationId works when a send receipt has no Location', async t => {
  const app = fixture(new SyntheticSkypeServer({ sendLocation: false }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.store.sendMessage(conversation.id, 'Keep the content');
  const send = app.server.sends[0]!;
  await app.server.publish(app.server.message(primary, send.nativeUrl, { direction: 'Outgoing', operationId: send.operationId }, 'Failure'));
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.length, 1);
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.body, 'Keep the content');
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
});

test('a failed send retains the original message and sanitized error without automatic replay', async t => {
  const app = fixture(new SyntheticSkypeServer({ sendStatus: 502 }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await assert.rejects(app.store.sendMessage(conversation.id, 'Keep this failed text 👋'), /HTTP 502/);
  const rows = app.store.getSnapshot().messages[conversation.id]!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.body, 'Keep this failed text 👋');
  assert.equal(rows[0]?.delivery, 'failed');
  assert.equal(rows[0]?.error?.includes(password), false);
  assert.equal(app.server.sends.length, 1);
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'connected');
});

test('stale failure or acceptance events cannot regress a delivered outgoing message', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.store.sendMessage(conversation.id, 'Already delivered');
  const send = app.server.sends[0]!;
  for (const status of ['Success', 'Failure', undefined]) {
    await app.server.publish(app.server.message(primary, send.nativeUrl, { direction: 'Outgoing', status: 'Pending' }, status));
  }
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.length, 1);
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'delivered');
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.body, 'Already delivered');
});

test('a failed invitation leaves the live account and existing chat usable', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.store.startConversation(conversation.accountId, 'alex@example.test');
  const request = app.server.calls.find(call => call.url === `${pool}/operations/invite`)!;
  const { operationId } = JSON.parse(request.body!);
  await app.server.publish({ sender: [{ rel: 'communication', events: [{
    type: 'completed', status: 'Failure', link: { rel: 'messagingInvitation', href: '/invitations/outgoing' },
    _embedded: { messagingInvitation: { direction: 'Outgoing', operationId, state: 'Failed' } },
  }] }] });
  assert.match(app.store.getSnapshot().notice?.message ?? '', /invitation failed/);
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'connected');
  await app.store.sendMessage(conversation.id, 'Existing chat still works');
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'accepted');
});

test('replayed connected invitations do not override a subsequent user selection', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const conversation = await app.connect();
  await app.store.startConversation(conversation.accountId, 'alex@example.test');
  const request = app.server.calls.find(call => call.url === `${pool}/operations/invite`)!;
  const { operationId } = JSON.parse(request.body!);
  const batch: UcwaEventBatch = { sender: [{ rel: 'communication', events: [{
    type: 'updated', status: 'Success', link: { rel: 'messagingInvitation', href: '/invitations/outgoing' },
    _embedded: { messagingInvitation: { direction: 'Outgoing', operationId, state: 'Connected', _links: { conversation: { href: secondary } } } },
  }] }] };
  await app.server.publish(batch);
  assert.equal(app.store.getSnapshot().selectedConversationId, scopedId(conversation.accountId, secondary));
  app.store.selectConversation(conversation.id);
  await app.server.publish(batch);
  assert.equal(app.store.getSnapshot().selectedConversationId, conversation.id);
});

test('invalid SIP targets are rejected before an invitation or other native request', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  await app.connect();
  const before = app.server.calls.length;
  for (const address of ['alex', 'alex@', 'alex@example.test@elsewhere.test', 'alex@example.test?redirect=https://elsewhere.test']) {
    await assert.rejects(app.connectors[0]!.startConversation(address), /complete SIP/);
  }
  assert.equal(app.server.calls.length, before);
});

test('missing availability capability cleans up the created application registration and pending poll', async t => {
  const app = fixture(new SyntheticSkypeServer({ intercept: call => call.url === `${pool}/registrations/collection`
    ? Response.json({ _links: { self: { href: registration }, events: { href: '/event-queue?after=initial' } }, _embedded: { me: {} } }, { status: 201 }) : undefined }));
  t.after(() => app.store.close());
  await assert.rejects(app.connect(), /does not offer/);
  assert.equal(app.server.calls.filter(call => call.url === registration && call.method === 'DELETE').length, 1);
  assert.equal(app.server.activeRequests.size, 0);
  assert.equal(app.server.removed, 1);
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'error');
});

test('read-only advertised messaging capabilities prevent sends and typing', async t => {
  const app = fixture(new SyntheticSkypeServer({ messaging: 'read-only' }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  assert.equal(conversation.capabilities.sendMessages, false);
  assert.equal(conversation.capabilities.typing, false);
  await assert.rejects(app.store.sendMessage(conversation.id, 'Unavailable'), /unavailable/);
  app.store.setTyping(conversation.id);
  assert.equal(app.server.calls.some(call => new URL(call.url).pathname.startsWith('/operations/send/')), false);
  assert.equal(app.server.calls.some(call => new URL(call.url).pathname.startsWith('/operations/typing/')), false);
});

test('disconnect cancels a pending message and event poll and removes the native scope once', async t => {
  const app = fixture(new SyntheticSkypeServer({ holdSend: true }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  const sending = app.store.sendMessage(conversation.id, 'Cancelled send');
  const rejection = assert.rejects(sending, /cancelled|disconnected/);
  await app.server.sendStarted.promise;
  await app.store.disconnectAccount(conversation.accountId);
  await rejection;
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.[0]?.delivery, 'failed');
  assert.equal(app.server.activeRequests.size, 0);
  assert.equal(app.server.removed, 1);
  assert.ok(app.server.cancelled >= 2);
  assert.equal(app.server.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('disconnect during token acquisition cancels without registering an application', async t => {
  const tokenStarted = new Deferred<void>();
  const app = fixture(new SyntheticSkypeServer({ intercept: async call => {
    if (call.url !== `${issuer}/tokens/password`) return undefined;
    tokenStarted.resolve();
    return abortable(new Deferred<Response>().promise, call.signal);
  } }));
  t.after(() => app.store.close());
  const connecting = app.connect();
  await tokenStarted.promise;
  await app.store.disconnectAccount(app.store.getSnapshot().accounts[0]!.id);
  await connecting;
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'disconnected');
  assert.equal(app.server.activeRequests.size, 0);
  assert.equal(app.server.calls.some(call => call.url === `${pool}/registrations/collection`), false);
  assert.equal(app.server.removed, 1);
});

test('disconnect while waiting for an origin decision removes the approval and prevents further requests', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  const connecting = app.connect({ trustedOrigins: [pool] });
  await until(() => app.store.getSnapshot().originApprovals[0], 'pending issuer approval');
  await app.store.disconnectAccount(app.store.getSnapshot().accounts[0]!.id);
  await connecting;
  assert.equal(app.store.getSnapshot().originApprovals.length, 0);
  assert.equal(app.server.calls.some(call => call.url.startsWith(issuer)), false);
  assert.equal(app.server.removed, 1);
});

test('malformed event JSON reports a sanitized stopped connection without retrying the cursor', async t => {
  let broken = false;
  const app = fixture(new SyntheticSkypeServer({ intercept: call => broken && new URL(call.url).pathname === '/event-queue'
    ? new Response(`{ malformed ${password}`, { headers: { 'content-type': 'application/json' } }) : undefined }));
  t.after(() => app.store.close());
  await app.connect();
  broken = true;
  app.server.push({ sender: [] });
  await until(() => app.store.getSnapshot().accounts[0]?.status === 'error' ? true : undefined, 'stopped event stream');
  assert.match(notice(app.store.getSnapshot()), /stopped/i);
  assert.equal(notice(app.store.getSnapshot()).includes(password), false);
  assert.equal(app.server.calls.filter(call => new URL(call.url).searchParams.get('after') === '1').length, 1);
});

test('missing message representations fail closed without inventing message bodies', async t => {
  const missing = `${pool}/messages/missing`;
  const app = fixture(new SyntheticSkypeServer({ intercept: call => call.url === missing ? new Response('not a resource') : undefined }));
  t.after(() => app.store.close());
  const conversation = await app.connect();
  app.server.push({ sender: [{ rel: 'conversation', href: primary, events: [{ type: 'added', link: { rel: 'message', href: missing } }] }] });
  await until(() => app.store.getSnapshot().accounts[0]?.status === 'error' ? true : undefined, 'invalid message resource failure');
  assert.equal(app.store.getSnapshot().messages[conversation.id]?.length ?? 0, 0);
  assert.match(notice(app.store.getSnapshot()), /stopped/i);
});

test('unsupported event relations are ignored without fetching arbitrary advertised URLs', async t => {
  const app = fixture();
  t.after(() => app.store.close());
  await app.connect();
  const unknown = 'https://unapproved.example.test/proprietary-event';
  await app.server.publish({ sender: [{ events: [{ type: 'added', link: { rel: 'vendorExtension', href: unknown } }] }] });
  assert.equal(app.server.calls.some(call => call.url === unknown), false);
  assert.equal(app.store.getSnapshot().accounts[0]?.status, 'connected');
  assert.equal(app.store.getSnapshot().originApprovals.length, 0);
});
