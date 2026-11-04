import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  TeamwireClient, TeamwireHttpError, TeamwireProtocolError, TeamwireSessionClosedError,
  TeamwireUnsupportedConversationError, UnsupportedAuthError,
} from '../src/index';
import { createEphemeralKey, deriveSessionSecret, TeamwireCrypto } from '../src/crypto';

const cryptoImplementation = webcrypto as unknown as Crypto;
const origin = 'https://messaging.example.test';
const conversationKey = 'abcdefghijklmnopqrstuvwxyz123456';
const timestamp = '2026-01-02T03:04:05.678Z';
const cursor = '2026-01-02T03:04:05.678901Z';
const hexCursor = Buffer.from(cursor).toString('hex');

// These fixture envelopes use Node's independent native AES implementation.
function encryptNative(text: string, key: string, iv = Buffer.alloc(16, 9)): string {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  return Buffer.concat([iv, createHash('sha256').update(iv).digest(), cipher.update(text), cipher.final()]).toString('base64');
}

function decryptNative(text: string, key: string): string {
  const envelope = Buffer.from(text, 'base64');
  assert.deepEqual(envelope.subarray(16, 48), createHash('sha256').update(envelope.subarray(0, 16)).digest());
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key), envelope.subarray(0, 16));
  return Buffer.concat([decipher.update(envelope.subarray(48)), decipher.final()]).toString('utf8');
}

interface Seen { path: string; init: RequestInit; payload?: Record<string, unknown> }
function server(options: {
  unsupportedAuth?: boolean;
  badServerKey?: boolean;
  sendStatus?: number;
  badReceipt?: boolean;
  version?: number;
  noEtag?: boolean;
  notModified?: boolean;
  badMessage?: boolean;
  missingSubscription?: boolean;
  logoutStatus?: number;
  pendingContacts?: Promise<void>;
} = {}) {
  const seen: Seen[] = [];
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.alloc(32, 7));
  let sessionKey = '';
  const subscription = {
    tid: 'thread-1', col: conversationKey, chat_v: options.version ?? 0,
    thread_info: { type: 'group', title: encryptNative('Research', conversationKey), is_closed: false, allowSending: true, admins: ['owner-1'] },
    members: { users: ['owner-1', 'person-2'], groups: [], roles: [] }, ts: timestamp,
  };
  const userMessage = {
    tid: 'thread-1', mid: 'message-1', from: 'person-2',
    m: options.badMessage ? 'invalid ciphertext' : encryptNative('Hello, world 👋', conversationKey),
    ts: timestamp,
  };
  const encrypted = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(encryptNative(JSON.stringify(data), sessionKey), { status, headers });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.match(headers.get('X-Request-ID')!, /^[\da-f-]{36}$/);
    const path = url.pathname + url.search;
    const entry: Seen = { path, init };
    seen.push(entry);
    if (path === '/v20/api_versions/?format=json') return Response.json({ versions: [20] });
    if (path === '/v20/u/sessions/') {
      assert.equal(init.method, 'POST');
      assert.equal(headers.get('Content-Type'), 'application/octet-stream');
      assert.equal(headers.has('From'), false);
      const body = JSON.parse(String(init.body));
      assert.match(body.client_pubkey, /^04[\da-f]{128}$/);
      sessionKey = ecdh.computeSecret(Buffer.from(body.client_pubkey, 'hex')).subarray(0, 24).toString('base64');
      return Response.json({ session_id: 'challenge-1', server_pubkey: options.badServerKey ? '00' : ecdh.getPublicKey('hex', 'uncompressed') });
    }
    assert.ok(sessionKey);
    if (path === '/v20/u/login/challenge-1/') {
      assert.equal(headers.has('From'), false);
      entry.payload = JSON.parse(decryptNative(String(init.body), sessionKey));
      return encrypted(options.unsupportedAuth ? { mfa_required: true } : { from_id: 'public-session-1', owner_id: 'owner-1', first_name: 'Alex' });
    }
    assert.equal(headers.get('From'), 'public-session-1');
    assert.equal(headers.has('Authorization'), false);
    if (init.body) entry.payload = JSON.parse(decryptNative(String(init.body), sessionKey));
    if (path === '/v20/contacts') {
      if (options.pendingContacts) await options.pendingContacts;
      return encrypted({ users: [{ id: 'person-2', first_name: 'Alex', last_name: 'Example', profile: { email: 'alex@example.test' } }] });
    }
    if (path === '/v20/u/subscriptions/?legacy_circle_ids=true') return encrypted([subscription]);
    if (path === '/v20/u/subscriptions/matching_ids?legacy_circle_ids=true') {
      return encrypted({ subscriptions: options.missingSubscription ? [] : [subscription] });
    }
    if (path === '/v20/t/thread-1/') return encrypted([userMessage]);
    if (path === '/v20/t') {
      if (options.sendStatus) return new Response('server details are not exposed', { status: options.sendStatus });
      return encrypted({ mid: 'accepted-1', tid: options.badReceipt ? 'another-thread' : 'thread-1', ts: timestamp });
    }
    if (path === '/v20/feed') {
      assert.ok(headers.get('ETag'));
      const responseHeaders: Record<string, string> = options.noEtag ? {} : { ETag: hexCursor };
      if (options.notModified) return new Response(null, { status: 304, headers: responseHeaders });
      return encrypted({
        messages: [{ ...subscription, from: 'sys', type: 'chat.created', mid: 'created-1' }, userMessage],
        read_threads: [{ tid: 'thread-1', last_read_ts: timestamp }],
      }, 200, responseHeaders);
    }
    if (path === '/v20/t/thread-1/readers') return new Response(null, { status: 204 });
    if (path === '/v20/u/preferences/') return encrypted({ favourite_chats: ['thread-1'], unread_chats: [], muted_chats: [], archived_chats: [] });
    if (path === '/v20/u/logout') return new Response('ok', { status: options.logoutStatus ?? 200 });
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  return { seen, fetch };
}

async function connected(options: Parameters<typeof server>[0] = {}) {
  const fixture = server(options);
  const client = new TeamwireClient({ origin, fetch: fixture.fetch, crypto: cryptoImplementation });
  const session = await client.loginPassword({ email: 'ALEX@EXAMPLE.TEST', password: 'synthetic-password' });
  return { ...fixture, client, session };
}

test('AES envelope interoperates with native AES and preserves Unicode', async () => {
  const crypto = new TeamwireCrypto(cryptoImplementation);
  const key = await crypto.importSecret(conversationKey);
  assert.equal(await crypto.decrypt(encryptNative('Example 👋', conversationKey), key), 'Example 👋');
  const encrypted = await crypto.encrypt('Example 👋', key);
  assert.equal(decryptNative(encrypted, conversationKey), 'Example 👋');
  assert.notEqual(encrypted, await crypto.encrypt('Example 👋', key));
});

test('secp256k1 exchange agrees with native ECDH and uses uncompressed public keys', () => {
  const local = createEphemeralKey();
  const remote = createECDH('secp256k1');
  remote.setPrivateKey(Buffer.alloc(32, 4));
  assert.equal(local.publicKey.length, 130);
  const expected = remote.computeSecret(Buffer.from(local.publicKey, 'hex')).subarray(0, 24).toString('base64');
  assert.equal(deriveSessionSecret(local.secretKey, remote.getPublicKey('hex', 'uncompressed')), expected);
  local.secretKey.fill(0);
});

test('rejects malformed encryption envelopes and invalid key lengths', async () => {
  const crypto = new TeamwireCrypto(cryptoImplementation);
  const key = await crypto.importSecret(conversationKey);
  await assert.rejects(crypto.importSecret('short'), TeamwireProtocolError);
  for (const value of ['not!base64', Buffer.alloc(48).toString('base64')]) {
    await assert.rejects(crypto.decrypt(value, key), TeamwireProtocolError);
  }
  const corrupted = Buffer.from(encryptNative('hello', conversationKey), 'base64');
  corrupted[16] = corrupted[16]! ^ 1;
  await assert.rejects(crypto.decrypt(corrupted.toString('base64'), key), TeamwireProtocolError);
});

test('requires an explicit HTTPS origin without embedded credentials or paths', () => {
  for (const value of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/api', 'https://example.test?x=1', 'https://example.test#x']) {
    assert.throws(() => new TeamwireClient({ origin: value, fetch: server().fetch, crypto: cryptoImplementation }));
  }
});

test('version discovery is unauthenticated and login lowercases and hashes the email', async () => {
  const { client, session, seen } = await connected();
  assert.equal(session.userId, 'owner-1');
  assert.deepEqual(await client.getSupportedApiVersions(), [20]);
  const login = seen.find(request => request.path.includes('/u/login/'))!;
  assert.equal(login.payload?.email_hash, createHash('sha256').update('alex@example.test').digest('hex'));
  assert.equal(login.payload?.password, 'synthetic-password');
  assert.equal(String(login.init.body).includes('synthetic-password'), false);
  session.close();
});

test('does not fabricate a session for MFA or incompatible key exchange', async () => {
  for (const options of [{ unsupportedAuth: true }, { badServerKey: true }]) {
    await assert.rejects(connected(options), UnsupportedAuthError);
  }
});

test('contacts and conversation titles normalize without exposing conversation keys', async () => {
  const { session } = await connected();
  const contacts = await session.getContacts();
  assert.equal(contacts[0]?.displayName, 'Alex Example');
  assert.equal(contacts[0]?.email, 'alex@example.test');
  const conversations = await session.getConversations();
  assert.equal(conversations[0]?.title, 'Research');
  assert.equal(conversations[0]?.canSend, true);
  assert.equal(conversations[0]?.raw.col, undefined);
  assert.equal(JSON.stringify(conversations).includes(conversationKey), false);
  assert.deepEqual((await session.getPreferences()).favouriteChatIds, ['thread-1']);
  session.close();
});

test('history loads missing conversation keys and decrypts message text', async () => {
  const { session, seen } = await connected();
  const history = await session.getHistory('thread-1', { since: timestamp });
  assert.equal(history[0]?.text, 'Hello, world 👋');
  assert.equal(history[0]?.decryption, 'decrypted');
  assert.equal(history[0]?.timestamp, timestamp);
  assert.deepEqual(seen.find(request => request.path.includes('matching_ids'))?.payload, { thread_ids: ['thread-1'] });
  const request = seen.find(request => request.path === '/v20/t/thread-1/')!;
  assert.equal(new Headers(request.init.headers).get('ETag'), Buffer.from(timestamp).toString('hex'));
  session.close();
});

test('corrupt or missing chat keys never turn ciphertext into visible plaintext', async () => {
  for (const [options, expected] of [[{ badMessage: true }, 'failed'], [{ missingSubscription: true }, 'missing-key']] as const) {
    const { session } = await connected(options);
    const history = await session.getHistory('thread-1');
    assert.equal(history[0]?.text, '');
    assert.equal(history[0]?.decryption, expected);
    session.close();
  }
});

test('send applies both encryption layers and reports acceptance separately from delivery', async () => {
  const { session, seen } = await connected();
  const receipt = await session.sendText('thread-1', 'Confidential example', { clientMessageId: 'correlation-1', replyTo: 'message-1' });
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(receipt.clientMessageId, 'correlation-1');
  const send = seen.find(request => request.path === '/v20/t')!;
  assert.equal(decryptNative(String(send.payload?.msg), conversationKey), 'Confidential example');
  assert.deepEqual(send.payload?.notification, { text: 'Encrypted message' });
  assert.equal(send.payload?.reply_to, 'message-1');
  assert.equal(String(send.init.body).includes('Confidential example'), false);
  session.close();
});

test('a failed send is never retried and response bodies do not enter error messages', async () => {
  const { session, seen } = await connected({ sendStatus: 503 });
  await assert.rejects(session.sendText('thread-1', 'Example'), error => {
    assert.ok(error instanceof TeamwireHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('server details'), false);
    return true;
  });
  assert.equal(seen.filter(request => request.path === '/v20/t').length, 1);
  session.close();
});

test('unknown conversation versions cannot send or be presented as decrypted', async () => {
  const { session, seen } = await connected({ version: 1 });
  assert.equal((await session.getConversations())[0]?.canSend, false);
  assert.equal((await session.getHistory('thread-1'))[0]?.decryption, 'unsupported');
  await assert.rejects(session.sendText('thread-1', 'Example'), TeamwireUnsupportedConversationError);
  assert.equal(seen.some(request => request.path === '/v20/t'), false);
  session.close();
});

test('mismatched send receipts are rejected', async () => {
  const { session } = await connected({ badReceipt: true });
  await assert.rejects(session.sendText('thread-1', 'Example'), TeamwireProtocolError);
  session.close();
});

test('feed keeps cursor precision, reads and events while redacting new conversation keys', async () => {
  const { session } = await connected();
  const feed = await session.getFeed({ since: timestamp });
  assert.equal(feed.cursor, cursor);
  assert.equal(feed.events[0]?.type, 'chat.created');
  assert.equal(feed.messages.find(message => !message.isSystem)?.text, 'Hello, world 👋');
  assert.deepEqual(feed.readThreads, [{ threadId: 'thread-1', timestamp }]);
  assert.equal(JSON.stringify(feed).includes(conversationKey), false);
  assert.equal(feed.events[0]?.raw.col, undefined);
  session.close();
});

test('304 without a response cursor preserves the previous cursor', async () => {
  const { session } = await connected({ noEtag: true, notModified: true });
  const feed = await session.getFeed({ since: cursor });
  assert.equal(feed.cursor, cursor);
  assert.deepEqual(feed.messages, []);
  session.close();
});

test('mark read uses the observed mid/mts request and logout clears session even on server failure', async () => {
  const { session, seen } = await connected({ logoutStatus: 503 });
  await session.markRead('thread-1', { messageId: 'message-1', timestamp });
  assert.deepEqual(seen.find(request => request.path.endsWith('/readers'))?.payload, { mid: 'message-1', mts: Date.parse(timestamp) });
  await assert.rejects(session.logout(), TeamwireHttpError);
  await assert.rejects(session.getContacts(), TeamwireSessionClosedError);
  const count = seen.length;
  await session.logout();
  assert.equal(seen.length, count);
});

test('in-flight reads cannot repopulate a closed session', async () => {
  let resolve!: () => void;
  const pendingContacts = new Promise<void>(done => { resolve = done; });
  const { session } = await connected({ pendingContacts });
  const contacts = session.getContacts();
  session.close();
  resolve();
  await assert.rejects(contacts, TeamwireSessionClosedError);
});

test('redirect responses are rejected even when the injected transport ignores redirect:error', async () => {
  const response = Response.json({ versions: [20] });
  Object.defineProperty(response, 'url', { value: 'https://different.example.test/v20/api_versions/' });
  const client = new TeamwireClient({ origin, crypto: cryptoImplementation, fetch: async () => response });
  await assert.rejects(client.getSupportedApiVersions(), TeamwireProtocolError);
});

test('caller cancellation is passed to the fetch transport', async () => {
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancellation'));
  const client = new TeamwireClient({ origin, crypto: cryptoImplementation, fetch: async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    init?.signal?.throwIfAborted();
    throw new Error('expected abort');
  } });
  await assert.rejects(client.getSupportedApiVersions({ signal: controller.signal }), /synthetic cancellation/);
});
