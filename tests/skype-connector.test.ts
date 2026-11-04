import assert from 'node:assert/strict';
import test from 'node:test';
import type { UcwaEventBatch, UcwaResource } from 'skypeforhoo';
import { SkypeConnector } from '../src/connectors/skype';
import { scopedId, type ConnectorEvent } from '../src/connectors/types';

const discovery = 'https://lyncdiscover.example.test/';
const pool = 'https://pool.example.test';
const issuer = 'https://identity.example.test';
const registration = `${pool}/registrations/opaque-client`;
const oldConversation = `${pool}/chats/existing`;
const newConversation = `${pool}/chats/new`;
const sentMessage = `${pool}/message-resources/accepted-one`;
const timestamp = '2026-03-04T05:06:07.000Z';
const accountId = 'synthetic-skype-account';

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Synthetic Skype fixture did not produce ${label}.`);
}

function fixture(options: { holdSendReply?: boolean; terminalFeed?: boolean } = {}) {
  const calls: { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }[] = [];
  const events: ConnectorEvent[] = [];
  const approvals: string[] = [];
  const queued: UcwaResource[] = [];
  const polls = new Set<{ deliver(data: UcwaResource): void }>();
  let sequence = 0;
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const lifetime = new AbortController();
  const connector = new SkypeConnector();
  const conversation = (url: string) => ({
    subject: url === oldConversation ? 'Existing conversation' : 'New conversation', created: timestamp, participantCount: 2,
    _links: { self: { href: url }, messaging: { href: `${url}/messaging` } },
    _embedded: { participant: [{ name: 'Alex Example', uri: 'sip:alex@example.test' }, { name: 'You', local: true }] },
  });
  const push = (batch: UcwaEventBatch, terminal = false) => {
    sequence += 1;
    const data = terminal ? batch : { ...batch, _links: { ...batch._links, next: { href: `/opaque/events?ack=${sequence}&checkpoint=preserved` } } };
    const waiting = polls.values().next().value;
    if (waiting) waiting.deliver(data);
    else queued.push(data);
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    if (url === discovery) return Response.json({ _links: { self: { href: discovery }, user: { href: `${pool}/discovery/advertised-user` } } });
    if (url === `${issuer}/advertised-token`) {
      const credentials = new URLSearchParams(String(init.body));
      assert.equal(credentials.get('username'), 'CORP\\separate.login');
      assert.equal(credentials.get('password'), 'synthetic-password');
      assert.equal(headers.has('authorization'), false);
      return Response.json({ token_type: 'Bearer', access_token: 'synthetic-access-token', expires_in: 3600 });
    }
    if (url === `${pool}/discovery/advertised-user`) {
      if (!headers.has('authorization')) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `MsRtcOAuth href="${issuer}/advertised-token", grant_type="password"` } });
      return Response.json({ _links: { applications: { href: '/registrations/advertised-collection' } } });
    }
    assert.equal(headers.get('authorization'), 'Bearer synthetic-access-token');
    assert.equal(String(init.body ?? '').includes('synthetic-password'), false);
    if (url === `${pool}/registrations/advertised-collection`) {
      assert.equal(method, 'POST');
      assert.equal(JSON.parse(String(init.body)).userAgent, 'Chattahoochee/0.1.0');
      return Response.json({
        _links: { self: { href: registration }, events: { href: '/opaque/events?ack=initial' }, me: { href: '/hubs/identity' }, people: { href: '/hubs/people' }, communication: { href: '/hubs/communication' } },
        _embedded: { me: { _links: { self: { href: '/hubs/identity' }, makeMeAvailable: { href: '/operations/become-available' } } } },
      }, { status: 201, headers: { location: registration } });
    }
    if (new URL(url).pathname === '/opaque/events') {
      if (queued.length) return Response.json(queued.shift());
      return new Promise<Response>((resolve, reject) => {
        const signal = init.signal;
        const poll = { deliver(data: UcwaResource) { cleanup(); resolve(Response.json(data)); } };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const cleanup = () => { polls.delete(poll); signal?.removeEventListener('abort', abort); };
        polls.add(poll);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    if (url === `${pool}/operations/become-available`) {
      assert.ok(calls.some((call) => new URL(call.url).pathname === '/opaque/events'), 'Poll begins before becoming available');
      assert.deepEqual(JSON.parse(String(init.body)), { supportedModalities: ['Messaging'], supportedMessageFormats: ['Plain'], signInAs: 'Online' });
      return new Response(null, { status: 204 });
    }
    if (url === `${pool}/hubs/people`) return Response.json({ _links: { myContacts: { href: '/directory/mine' } } });
    if (url === `${pool}/directory/mine`) return Response.json({ _embedded: { contact: [{
      name: 'Alex Example', uri: 'sip:alex@example.test',
      _links: { self: { href: '/directory/alex' } },
      _embedded: { contactPresence: { availability: 'Online' } },
    }] } });
    if (url === `${pool}/hubs/communication`) return Response.json({ _links: { conversations: { href: '/chats/advertised-index' }, startMessaging: { href: '/operations/invite-chat' } } });
    if (url === `${pool}/chats/advertised-index`) return Response.json({ _embedded: { conversation: [conversation(oldConversation)] } });
    if ([oldConversation, newConversation].includes(url)) return Response.json(conversation(url));
    if (url === `${oldConversation}/messaging` || url === `${newConversation}/messaging`) return Response.json({
      _links: { self: { href: url }, sendMessage: { href: '/operations/send-text?existing=retained' }, setIsTyping: { href: '/operations/report-typing' } },
    });
    if (url === `${pool}/participants/alex`) return Response.json({ name: 'Alex Example' });
    if (new URL(url).pathname === '/operations/send-text') {
      assert.equal(method, 'POST');
      assert.equal(headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(new URL(url).searchParams.get('existing'), 'retained');
      if (options.holdSendReply) await sendGate;
      return new Response(null, { status: 201, headers: { location: sentMessage } });
    }
    if (url === `${pool}/operations/invite-chat`) {
      const operationId = String(JSON.parse(String(init.body)).operationId);
      push({ sender: [{ rel: 'communication', href: '/hubs/communication', events: [{
        type: 'updated', link: { rel: 'messagingInvitation', href: '/invitations/outgoing-one' },
        _embedded: { messagingInvitation: { direction: 'Outgoing', state: 'Connected', operationId, _links: { conversation: { href: newConversation } } } },
      }] }] });
      return new Response(null, { status: 201, headers: { location: '/invitations/outgoing-one' } });
    }
    if (url === `${pool}/operations/accept-incoming` || url === `${pool}/operations/report-typing`) return new Response(null, { status: 204 });
    if (url === registration && method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail(`Unexpected synthetic request: ${method} ${url}`);
  };
  const connect = async () => {
    await connector.connect({ provider: 'skype', address: 'sip.identity@example.test', loginUsername: 'CORP\\separate.login', password: 'synthetic-password', server: discovery }, {
      accountId, fetch, signal: lifetime.signal,
      approveOrigin: async (origin) => { approvals.push(origin); return true; },
      emit: (event) => events.push(event),
    });
    if (options.terminalFeed) push({ sender: [] }, true);
    return events.find((event): event is Extract<ConnectorEvent, { type: 'conversation' }> => event.type === 'conversation' && event.conversation.nativeId === oldConversation)!.conversation;
  };
  const complete = (status: 'Success' | 'Failure', operationId?: string): UcwaEventBatch => ({ sender: [{
    rel: 'conversation', href: oldConversation, events: [{
      type: 'completed', status, link: { rel: 'message', href: sentMessage },
      _embedded: { message: { direction: 'Outgoing', timeStamp: timestamp, ...(operationId ? { operationId } : {}), _links: { self: { href: sentMessage } } } },
    }],
  }] });
  return { connector, connect, calls, events, approvals, push, complete, releaseSend, activePolls: () => polls.size };
}

test('Skype connector follows advertised resources, uses separate credentials, receives Unicode, and disconnects', async (t) => {
  const server = fixture();
  t.after(() => server.connector.disconnect());
  const conversation = await server.connect();
  assert.deepEqual(server.approvals.sort(), [issuer, pool]);
  assert.equal(conversation.id, scopedId(accountId, oldConversation));
  assert.deepEqual(conversation.participants, ['Alex Example']);
  assert.equal(conversation.capabilities.sendMessages, true);
  assert.equal(conversation.capabilities.audio, false);
  const contact = server.events.find((event) => event.type === 'contact');
  assert.ok(contact?.type === 'contact');
  assert.equal(contact.contact.presence, 'online');
  const text = 'Grüße 👋 Ελληνικά 日本語';
  server.push({ sender: [{ rel: 'conversation', href: oldConversation, events: [{
    type: 'added', link: { rel: 'message', href: '/messages/incoming-one' },
    _embedded: { message: { direction: 'Incoming', timeStamp: timestamp, _links: {
      self: { href: '/messages/incoming-one' }, participant: { href: '/participants/alex' },
      plainMessage: { href: `data:text/plain;charset=utf-8;base64,${Buffer.from(text).toString('base64')}` },
    } } },
  }] }] });
  const incoming = await waitFor(() => server.events.find((event) => event.type === 'message' && event.message.direction === 'incoming'), 'incoming message');
  assert.ok(incoming.type === 'message');
  assert.equal(incoming.message.body, text);
  assert.equal(incoming.message.senderName, 'Alex Example');
  assert.equal(incoming.message.conversationId, conversation.id);
  assert.equal(incoming.message.createdAt, timestamp);
  await server.connector.disconnect();
  assert.equal(server.activePolls(), 0);
  assert.equal(server.calls.filter((call) => call.method === 'DELETE' && call.url === registration).length, 1);
});

test('send receipt Location correlates event-level completion to the optimistic message without an empty duplicate', async (t) => {
  const server = fixture();
  t.after(() => server.connector.disconnect());
  const conversation = await server.connect();
  await server.connector.sendMessage(conversation, 'An outgoing message 👋', 'operation-one');
  const send = server.calls.find((call) => new URL(call.url).pathname === '/operations/send-text')!;
  assert.equal(new URL(send.url).searchParams.get('operationId'), 'operation-one');
  assert.equal(send.body, 'An outgoing message 👋');
  server.push(server.complete('Failure'));
  const status = await waitFor(() => server.events.find((event) => event.type === 'delivery'), 'correlated delivery failure');
  assert.ok(status.type === 'delivery');
  assert.equal(status.messageId, scopedId(accountId, 'operation-one'));
  assert.equal(status.delivery, 'failed');
  assert.equal(server.events.some((event) => event.type === 'message' && event.message.direction === 'outgoing' && event.message.body === ''), false);
});

test('completion arriving before HTTP receipt reconciles its native ID and retains the observed failure', async (t) => {
  const server = fixture({ holdSendReply: true });
  t.after(async () => { server.releaseSend(); await server.connector.disconnect(); });
  const conversation = await server.connect();
  const sending = server.connector.sendMessage(conversation, 'Keep the optimistic text', 'early-operation');
  await waitFor(() => server.calls.find((call) => new URL(call.url).pathname === '/operations/send-text'), 'send request');
  await server.connector.handleBatch(server.complete('Failure'));
  server.releaseSend();
  await sending;
  const reconciled = server.events.find((event) => event.type === 'message' && event.replacesMessageId === scopedId(accountId, sentMessage));
  assert.ok(reconciled?.type === 'message');
  assert.equal(reconciled.message.id, scopedId(accountId, 'early-operation'));
  assert.equal(reconciled.message.body, 'Keep the optimistic text');
  assert.equal(reconciled.message.delivery, 'failed');
});

test('an explicit outgoing invitation selects its resulting chat when another conversation exists', async (t) => {
  const server = fixture();
  t.after(() => server.connector.disconnect());
  await server.connect();
  await server.connector.startConversation('alex@example.test');
  const selected = await waitFor(() => server.events.find((event) => event.type === 'select-conversation'), 'new chat selection');
  assert.ok(selected.type === 'select-conversation');
  assert.equal(selected.conversationId, scopedId(accountId, newConversation));
  const invitation = JSON.parse(String(server.calls.find((call) => call.url === `${pool}/operations/invite-chat`)!.body));
  assert.equal(invitation.to, 'sip:alex@example.test');
  assert.match(invitation.operationId, /^[\da-f-]{36}$/);
});

test('incoming invitations are accepted once without changing the selected conversation', async (t) => {
  const server = fixture();
  t.after(() => server.connector.disconnect());
  await server.connect();
  const incoming: UcwaEventBatch = { sender: [{ rel: 'communication', href: '/hubs/communication', events: [{
    type: 'added', link: { rel: 'messagingInvitation', href: '/invitations/incoming-one' },
    _embedded: { messagingInvitation: { direction: 'Incoming', operationId: 'someone-elses-operation', state: 'Connecting', _links: { accept: { href: '/operations/accept-incoming' }, conversation: { href: newConversation } } } },
  }] }] };
  await server.connector.handleBatch(incoming);
  await server.connector.handleBatch(incoming);
  assert.equal(server.calls.filter((call) => call.url === `${pool}/operations/accept-incoming`).length, 1);
  assert.equal(server.events.some((event) => event.type === 'select-conversation'), false);
});

test('unexpectedly ending the event stream reports a stopped connection', async (t) => {
  const server = fixture({ terminalFeed: true });
  t.after(() => server.connector.disconnect());
  await server.connect();
  const stopped = await waitFor(() => server.events.find((event) => event.type === 'error'), 'stopped stream notice');
  assert.ok(stopped.type === 'error');
  assert.match(stopped.message, /stopped/i);
});
