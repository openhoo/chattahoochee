import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import test from 'node:test';
import {
  TeamwireClient, TeamwireProtocolError, TeamwireSessionClosedError,
  TeamwireUnsupportedConversationError, UnsupportedAuthError,
} from '../src/index';

const origin = 'https://chat.example.test';
const keyOne = 'abcdefghijklmnopqrstuvwxyz123456';
const keyTwo = '0123456789abcdefghijklmnopqrstuv';
const timestamp = '2026-01-02T03:04:05.678Z';
const cursor = '2026-01-02T03:04:06.123456Z';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

function encrypt(plaintext: string, key: string): string {
  const iv = Buffer.alloc(16, 17);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  return Buffer.concat([iv, createHash('sha256').update(iv).digest(), cipher.update(plaintext), cipher.final()]).toString('base64');
}

function decrypt(envelope: string, key: string): unknown {
  const bytes = Buffer.from(envelope, 'base64');
  const cipher = createDecipheriv('aes-256-cbc', Buffer.from(key), bytes.subarray(0, 16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(48)), cipher.final()]).toString());
}

function subscription(id = 'thread-1', col = keyOne, info: Record<string, unknown> = {}) {
  return { tid: id, col, thread_info: { type: 'group', title: 'Example', admins: [], ...info }, members: { users: ['owner', 'peer'], groups: [], roles: [] }, ts: timestamp };
}

function message(id = 'message-1', tid = 'thread-1', key = keyOne, text = 'Example') {
  return { mid: id, tid, from: 'peer', ts: timestamp, m: encrypt(text, key) };
}

interface Scenario {
  login?: unknown;
  subscriptions?: unknown[];
  contacts?: unknown;
  preferences?: unknown;
  history?: Record<string, unknown[]>;
  feed?: unknown;
  etag?: string;
  receipt?: unknown;
  pendingContacts?: Deferred<void>;
}

function fixture(scenario: Scenario = {}) {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.alloc(32, 19));
  let sessionKey = '';
  const requests: Array<{ path: string; signal?: AbortSignal | null; payload?: unknown }> = [];
  const contactsStarted = new Deferred<AbortSignal | null | undefined>();
  const response = (data: unknown) => new Response(encrypt(JSON.stringify(data), sessionKey));
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin);
    const path = url.pathname + url.search;
    const entry: { path: string; signal?: AbortSignal | null; payload?: unknown } = { path, signal: init.signal };
    requests.push(entry);
    if (path === '/v20/u/sessions/') {
      const challenge = JSON.parse(String(init.body));
      sessionKey = ecdh.computeSecret(Buffer.from(challenge.client_pubkey, 'hex')).subarray(0, 24).toString('base64');
      return Response.json({ session_id: 'challenge', server_pubkey: ecdh.getPublicKey('hex', 'uncompressed') });
    }
    if (path === '/v20/u/login/challenge/') return response(scenario.login ?? { from_id: 'public-session', owner_id: 'owner' });
    assert.equal(new Headers(init.headers).get('From'), 'public-session');
    if (init.body) entry.payload = decrypt(String(init.body), sessionKey);
    if (path === '/v20/contacts') {
      contactsStarted.resolve(init.signal);
      if (scenario.pendingContacts) {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(init.signal?.reason);
          init.signal?.addEventListener('abort', aborted, { once: true });
          scenario.pendingContacts!.promise.then(resolve).finally(() => init.signal?.removeEventListener('abort', aborted));
        });
      }
      return response(scenario.contacts ?? { users: [] });
    }
    if (path === '/v20/u/subscriptions/?legacy_circle_ids=true') return response(scenario.subscriptions ?? [subscription()]);
    if (path === '/v20/u/subscriptions/matching_ids?legacy_circle_ids=true') return response({ subscriptions: scenario.subscriptions ?? [subscription()] });
    if (path === '/v20/u/preferences/') return response(scenario.preferences ?? {});
    if (path === '/v20/feed') {
      const result = response(scenario.feed ?? { messages: [], read_threads: [] });
      result.headers.set('ETag', scenario.etag ?? Buffer.from(cursor).toString('hex'));
      return result;
    }
    const history = /^\/v20\/t\/([^/]+)\/$/.exec(url.pathname);
    if (history) return response(scenario.history?.[decodeURIComponent(history[1]!)] ?? []);
    if (path === '/v20/t') return response(scenario.receipt ?? { mid: 'accepted', tid: 'thread-1', ts: timestamp });
    if (path === '/v20/u/logout') return new Response('ok');
    throw new Error(`Unexpected synthetic endpoint: ${path}`);
  };
  const client = new TeamwireClient({ origin, fetch });
  return {
    client, requests, contactsStarted,
    session: () => client.loginPassword({ email: 'user@example.test', password: 'synthetic-password' }),
  };
}

async function deadline<T>(promise: Promise<T>, milliseconds = 150): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The closed operation did not settle promptly.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('a public session identity cannot substitute for a missing human owner identity', async () => {
  const server = fixture({ login: { from_id: 'public-session' } });
  await assert.rejects(server.session(), UnsupportedAuthError);
  assert.equal(server.requests.length, 2);
});

test('malformed owner/session identities never become authenticated sessions', async () => {
  for (const login of [
    { from_id: 'public-session', owner_id: {} },
    { from_id: 'public-session', owner_id: '' },
    { from_id: 'public\r\nInjected: value', owner_id: 'owner' },
    { from_id: 'public-session', owner_id: 'https://other.example/user' },
  ]) await assert.rejects(fixture({ login }).session(), UnsupportedAuthError);
});

test('empty directories, subscriptions and history remain a valid connected session', async () => {
  const server = fixture({ subscriptions: [], history: { 'thread-1': [] } });
  const session = await server.session();
  assert.deepEqual(await session.getContacts(), []);
  assert.deepEqual(await session.getConversations(), []);
  assert.deepEqual(await session.getHistory('thread-1'), []);
  assert.deepEqual((await session.getFeed()).messages, []);
  session.close();
});

test('multiple conversations use their respective keys without decrypting into each other', async () => {
  const server = fixture({
    subscriptions: [subscription(), subscription('thread-2', keyTwo)],
    history: { 'thread-1': [message()], 'thread-2': [message('second', 'thread-2', keyTwo, 'Second key')] },
  });
  const session = await server.session();
  assert.equal((await session.getConversations()).length, 2);
  const histories = await Promise.all([session.getHistory('thread-1'), session.getHistory('thread-2')]);
  assert.equal(histories[0]![0]?.text, 'Example');
  assert.equal(histories[1]![0]?.text, 'Second key');
  session.close();
});

test('a caller cannot mutate a returned conversation to enable a forbidden send', async () => {
  const server = fixture({ subscriptions: [subscription('thread-1', keyOne, { is_closed: true })] });
  const session = await server.session();
  const conversations = await session.getConversations();
  assert.equal(conversations[0]?.canSend, false);
  conversations[0]!.canSend = true;
  await assert.rejects(session.sendText('thread-1', 'Must remain forbidden'), TeamwireUnsupportedConversationError);
  assert.equal(server.requests.some(row => row.path === '/v20/t'), false);
  session.close();
});

test('a malformed subscription batch cannot partially update private conversation permissions', async () => {
  const scenario: Scenario = { subscriptions: [subscription('thread-1', keyOne, { is_closed: true })] };
  const server = fixture(scenario);
  const session = await server.session();
  await session.getConversations();
  scenario.subscriptions = [subscription(), { tid: 'broken' }];
  await assert.rejects(session.getConversations(), TeamwireProtocolError);
  await assert.rejects(session.sendText('thread-1', 'Partial batch must not open the chat'), TeamwireUnsupportedConversationError);
  assert.equal(server.requests.some(row => row.path === '/v20/t'), false);
  session.close();
});

for (const invalidCursor of ['1', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00Z\n']) {
  test(`an invalid synchronization cursor is rejected before network I/O: ${JSON.stringify(invalidCursor)}`, async () => {
    const server = fixture();
    const session = await server.session();
    const count = server.requests.length;
    await assert.rejects(session.getFeed({ since: invalidCursor }), TeamwireProtocolError);
    assert.equal(server.requests.length, count);
    session.close();
  });
}

test('malformed response ETags cannot become subsequent feed cursors', async () => {
  for (const etag of ['not-hex', '6162', '00', '"123"', Buffer.from('2026-02-30T00:00:00Z').toString('hex')]) {
    const server = fixture({ etag });
    const session = await server.session();
    await assert.rejects(session.getFeed(), TeamwireProtocolError);
    session.close();
  }
});

test('a weak quoted ETag preserves an otherwise valid cursor with submillisecond precision', async () => {
  const server = fixture({ etag: `W/"${Buffer.from(cursor).toString('hex')}"` });
  const session = await server.session();
  assert.equal((await session.getFeed()).cursor, cursor);
  session.close();
});

test('invalid calendar timestamps cannot masquerade as valid messages', async () => {
  const server = fixture({ history: { 'thread-1': [{ ...message(), ts: '2026-02-30T00:00:00Z' }] } });
  const session = await server.session();
  await assert.rejects(session.getHistory('thread-1'), TeamwireProtocolError);
  session.close();
});

test('a history response cannot inject a different conversation into the requested history', async () => {
  const server = fixture({
    subscriptions: [subscription(), subscription('thread-2', keyTwo)],
    history: { 'thread-1': [message('foreign', 'thread-2', keyTwo, 'Foreign history')] },
  });
  const session = await server.session();
  await assert.rejects(session.getHistory('thread-1'), TeamwireProtocolError);
  session.close();
});

test('hostile identifiers are rejected without turning them into endpoint paths', async () => {
  const server = fixture();
  const session = await server.session();
  const count = server.requests.length;
  for (const id of ['..', '.', '../u/logout', '//other.example/collect', 'x?token=y', 'x#fragment', 'x\nFrom:y', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(session.getHistory(id as string), TeamwireProtocolError);
  }
  assert.equal(server.requests.length, count);
  session.close();
});

test('untrusted URL metadata never produces additional requests or origin changes', async () => {
  const hostile = ['javascript:alert(1)', 'file:///private/data', 'https://other.example/collect', '//other.example/tracker'];
  const server = fixture({
    contacts: { users: [{ id: 'peer', first_name: 'Example', profile: { avatar_url: hostile[2], links: hostile } }] },
    subscriptions: [{ ...subscription(), links: hostile, thread_info: { type: 'group', title: hostile[0] } }],
    history: { 'thread-1': [{ ...message(), attachments: hostile }] },
  });
  const session = await server.session();
  await session.getContacts();
  await session.getConversations();
  await session.getHistory('thread-1');
  assert.deepEqual(server.requests.map(row => row.path), [
    '/v20/u/sessions/', '/v20/u/login/challenge/', '/v20/contacts',
    '/v20/u/subscriptions/?legacy_circle_ids=true', '/v20/t/thread-1/',
  ]);
  session.close();
});

test('all public protocol records redact nested conversation key material', async () => {
  const server = fixture({
    contacts: { users: [{ id: 'peer', profile: { metadata: { col: keyOne } } }] },
    preferences: { metadata: { col: keyOne } },
    receipt: { mid: 'accepted', tid: 'thread-1', ts: timestamp, metadata: { col: keyOne } },
  });
  const session = await server.session();
  const values = [await session.getContacts(), await session.getPreferences(), await session.sendText('thread-1', 'Example')];
  assert.equal(JSON.stringify(values).includes(keyOne), false);
  session.close();
});

test('explicit leave state prevents a stale subscription read from reopening a conversation', async () => {
  const scenario: Scenario = { feed: { messages: [
    { from: 'sys', type: 'chats.leave', chats: ['thread-1'] }, message(),
  ], read_threads: [] } };
  const server = fixture(scenario);
  const session = await server.session();
  await session.getConversations();
  await session.getFeed();
  assert.equal((await session.getConversations())[0]?.canSend, false);
  await assert.rejects(session.sendText('thread-1', 'Must stay closed'), TeamwireUnsupportedConversationError);
  assert.equal(server.requests.some(row => row.path === '/v20/t'), false);
  scenario.feed = { messages: [{ from: 'sys', type: 'chats.join', chats: ['thread-1'] }], read_threads: [] };
  await session.getFeed();
  assert.equal((await session.getConversations())[0]?.canSend, true);
  assert.equal((await session.sendText('thread-1', 'Joined again')).delivery, 'accepted');
  session.close();
});

test('closing a session aborts pending HTTP requests rather than only discarding their results', async () => {
  const hold = new Deferred<void>();
  const server = fixture({ pendingContacts: hold });
  const session = await server.session();
  const pending = session.getContacts();
  const result = pending.then(() => undefined, error => error);
  const signal = await server.contactsStarted.promise;
  try {
    session.close();
    assert.equal(signal?.aborted, true);
    assert.ok(await deadline(result));
  } finally { hold.resolve(); await result; }
});

test('closing a feed iterator interrupts its idle polling wait promptly', async () => {
  const server = fixture();
  const session = await server.session();
  const iterator = session.watchFeed({ intervalMs: 500 });
  assert.equal((await iterator.next()).done, false);
  const pending = iterator.next();
  session.close();
  const result = await deadline(pending);
  assert.equal(result.done, true);
  assert.equal(server.requests.filter(row => row.path === '/v20/feed').length, 1);
});

test('closing one session does not invalidate another independent session on the same origin', async () => {
  const one = fixture();
  const two = fixture();
  const sessionOne = await one.session();
  const sessionTwo = await two.session();
  sessionOne.close();
  await assert.rejects(sessionOne.getContacts(), TeamwireSessionClosedError);
  assert.deepEqual(await sessionTwo.getContacts(), []);
  sessionTwo.close();
});
