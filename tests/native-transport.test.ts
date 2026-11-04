import assert from 'node:assert/strict';
import test from 'node:test';
import { bearerAuth, SkypeForHoo } from 'skypeforhoo';
import { NativeAccountTransport, NativeTransportError, safeError, type Invoke } from '../src/lib/native-transport';

const firstOrigin = 'https://first.example.test';
const secondOrigin = 'https://second.example.test';
type Invocation = { command: string; args: Record<string, unknown> };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function bridge(handler: (call: Invocation) => unknown | Promise<unknown> = () => undefined) {
  const calls: Invocation[] = [];
  const invoke: Invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const call = { command, args };
    calls.push(call);
    return await handler(call) as T;
  };
  return { calls, invoke };
}

function reply(options: { status?: number; headers?: [string, string][]; body?: Uint8Array; url?: string } = {}) {
  return {
    status: options.status ?? 200,
    headers: options.headers ?? [],
    url: options.url ?? `${firstOrigin}/messages`,
    body: Buffer.from(options.body ?? []).toString('base64'),
    bodyEncoding: 'base64',
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native binary bridge preserves every byte in both directions and scopes its IPC request', async () => {
  const requestBody = Uint8Array.from({ length: 20_003 }, (_, index) => index % 256);
  const responseBody = Uint8Array.from([255, 0, 128, 1, 254, 10]);
  const native = bridge(({ command }) => command === 'account_http' ? reply({ body: responseBody }) : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const response = await transport.fetch(`${firstOrigin}/messages`, {
    method: 'POST', credentials: 'omit', body: requestBody,
    headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/octet-stream' },
  });
  const request = native.calls.find((call) => call.command === 'account_http')!.args;
  assert.equal(request.accountId, 'account-one');
  assert.match(String(request.requestId), /^[\da-f-]{36}$/);
  assert.equal(request.method, 'POST');
  assert.equal(request.bodyEncoding, 'base64');
  assert.deepEqual(Buffer.from(String(request.body), 'base64'), Buffer.from(requestBody));
  assert.equal(new Headers(request.headers as [string, string][]).get('authorization'), 'Bearer synthetic-token');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), responseBody);
  assert.equal(response.url, `${firstOrigin}/messages`);
});

test('streaming request chunks are copied before a producer reuses its buffer', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const input = new Request(firstOrigin, { method: 'POST', credentials: 'omit', body, duplex: 'half' } as RequestInit);
  const pending = transport.fetch(input);
  const reused = new Uint8Array([1, 2]);
  source.enqueue(reused);
  await turn();
  reused.set([3, 4]);
  source.enqueue(reused);
  await turn();
  source.close();
  await pending;
  const payload = native.calls.find((call) => call.command === 'account_http')!.args;
  assert.deepEqual(Buffer.from(String(payload.body), 'base64'), Buffer.from([1, 2, 3, 4]));
});

test('non-byte request streams fail as TypeError and cancel their source before IPC', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; controller.enqueue('invalid byte chunk' as unknown as Uint8Array); },
    cancel() { sourceCancelled = true; },
  });
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const input = new Request(firstOrigin, { method: 'POST', credentials: 'omit', body, duplex: 'half' } as RequestInit);
  let rejection: unknown;
  const completed = transport.fetch(input).catch((error: unknown) => { rejection = error; });
  await turn();
  try {
    assert.ok(rejection instanceof TypeError);
    assert.equal(sourceCancelled, true);
    assert.equal(native.calls.some((call) => call.command === 'account_http'), false);
  } finally {
    if (!sourceCancelled) source.close();
    await completed;
  }
});

test('HTTP 401 and all duplicate authentication challenges reach the SDK response', async () => {
  const native = bridge(({ command }) => command === 'account_http' ? reply({
    status: 401,
    headers: [
      ['www-authenticate', 'Bearer realm="example"'],
      ['www-authenticate', 'MsRtcOAuth grant_type="password", service="https://first.example.test/token"'],
    ],
    body: new TextEncoder().encode('Authentication required'),
  }) : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const response = await transport.fetch(firstOrigin, { credentials: 'omit' });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="example", MsRtcOAuth grant_type="password", service="https://first.example.test/token"');
  assert.equal(await response.text(), 'Authentication required');
});

test('bodyless response statuses and HEAD responses construct valid Fetch responses', async () => {
  for (const [method, status] of [['GET', 204], ['GET', 205], ['GET', 304], ['HEAD', 200]] as const) {
    const native = bridge(({ command }) => command === 'account_http' ? reply({ status }) : undefined);
    const transport = new NativeAccountTransport('account-one', native.invoke);
    await transport.allowOrigins([firstOrigin]);
    const response = await transport.fetch(firstOrigin, { method, credentials: 'omit' });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
  }
});

test('manual redirect responses remain inspectable without forwarding account credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const destination = 'https://unapproved.example.test/token';
    const native = bridge(({ command }) => command === 'account_http' ? reply({ status, headers: [['location', destination]] }) : undefined);
    const transport = new NativeAccountTransport('account-one', native.invoke);
    await transport.allowOrigins([firstOrigin]);
    const response = await transport.fetch(firstOrigin, { credentials: 'omit', redirect: 'manual', headers: { authorization: 'Bearer synthetic-token' } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('location'), destination);
    assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 1);
  }
});

test('Fetch redirect error mode rejects redirect responses without a second native request', async () => {
  const native = bridge(({ command }) => command === 'account_http' ? reply({ status: 302, headers: [['location', `${secondOrigin}/token`]] }) : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin, secondOrigin]);
  await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit', redirect: 'error' }), TypeError);
  assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 1);
});

test('only explicitly approved origins are available to the corresponding account', async () => {
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const first = new NativeAccountTransport('account-one', native.invoke);
  const second = new NativeAccountTransport('account-two', native.invoke);
  await first.allowOrigins([firstOrigin]);
  await second.allowOrigins([secondOrigin]);
  assert.deepEqual(native.calls.filter((call) => call.command === 'configure_account_transport').map((call) => call.args), [
    { accountId: 'account-one', origins: [firstOrigin] },
    { accountId: 'account-two', origins: [secondOrigin] },
  ]);
  for (const denied of [secondOrigin, `${firstOrigin}:444`, 'https://first.example.test.other.test', 'http://first.example.test']) {
    await assert.rejects(first.fetch(denied, { credentials: 'omit' }), { code: 'unapproved_origin' });
  }
  await assert.rejects(second.fetch(firstOrigin, { credentials: 'omit' }), { code: 'unapproved_origin' });
  await first.fetch(firstOrigin, { credentials: 'omit' });
  await second.fetch(secondOrigin, { credentials: 'omit' });
  assert.deepEqual(native.calls.filter((call) => call.command === 'account_http').map((call) => call.args.accountId), ['account-one', 'account-two']);
});

test('origin configuration rejects credentials, paths, queries, fragments, and non-HTTPS values before IPC', async () => {
  const native = bridge();
  const transport = new NativeAccountTransport('account-one', native.invoke);
  for (const invalid of ['http://first.example.test', `${firstOrigin}/api`, `${firstOrigin}?query=1`, `${firstOrigin}#section`, 'https://*.example.test', 'https://user:synthetic-password@first.example.test']) {
    await assert.rejects(transport.allowOrigins([invalid]), TypeError);
  }
  assert.equal(native.calls.length, 0);
});

test('ambient browser credentials never enter the account HTTP broker', async () => {
  const native = bridge();
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  for (const credentials of [undefined, 'include', 'same-origin'] as const) {
    await assert.rejects(transport.fetch(firstOrigin, credentials ? { credentials } : undefined), { code: 'ambient_credentials' });
  }
  assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 0);
});

test('simultaneous origin approvals retain the union in both the bridge and native broker', async () => {
  const configuration = deferred<void>();
  let configurationCount = 0;
  let approved = new Set<string>();
  const native = bridge(async ({ command, args }) => {
    if (command === 'configure_account_transport') {
      configurationCount += 1;
      if (configurationCount === 1) await configuration.promise;
      approved = new Set(args.origins as string[]);
    }
    if (command === 'account_http') {
      assert.ok(approved.has(new URL(String(args.url)).origin));
      return reply();
    }
  });
  const transport = new NativeAccountTransport('account-one', native.invoke);
  const first = transport.allowOrigins([firstOrigin]);
  const second = transport.allowOrigins([secondOrigin]);
  await turn();
  configuration.resolve();
  await Promise.all([first, second]);
  assert.deepEqual([...approved].sort(), [firstOrigin, secondOrigin]);
  await transport.fetch(firstOrigin, { credentials: 'omit' });
  await transport.fetch(secondOrigin, { credentials: 'omit' });
});

test('a failed configuration does not approve an origin or block later approvals', async () => {
  let fail = true;
  const native = bridge(({ command }) => {
    if (command === 'configure_account_transport' && fail) { fail = false; throw { code: 'transport_unavailable', message: 'synthetic' }; }
    if (command === 'account_http') return reply();
  });
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await assert.rejects(transport.allowOrigins([firstOrigin]));
  await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit' }), { code: 'unapproved_origin' });
  await transport.allowOrigins([secondOrigin]);
  await transport.fetch(secondOrigin, { credentials: 'omit' });
  assert.deepEqual(native.calls.filter((call) => call.command === 'configure_account_transport').at(-1)!.args.origins, [secondOrigin]);
});

test('an already aborted Fetch request never invokes account HTTP', async () => {
  const native = bridge();
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 0);
});

test('in-flight abort sends the account and request IDs and rejects a late native reply', async () => {
  const response = deferred<ReturnType<typeof reply>>();
  const native = bridge(({ command }) => command === 'account_http' ? response.promise : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const controller = new AbortController();
  const request = transport.fetch(firstOrigin, { credentials: 'omit', signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await turn();
  controller.abort();
  response.resolve(reply());
  await rejected;
  const requestArgs = native.calls.find((call) => call.command === 'account_http')!.args;
  assert.deepEqual(native.calls.find((call) => call.command === 'cancel_account_http')!.args, {
    accountId: 'account-one', requestId: requestArgs.requestId,
  });
});

test('aborting Fetch rejects before the native cancellation acknowledgement or response arrives', async () => {
  const response = deferred<ReturnType<typeof reply>>();
  const cancellation = deferred<void>();
  const native = bridge(({ command }) => command === 'account_http' ? response.promise : command === 'cancel_account_http' ? cancellation.promise : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const controller = new AbortController();
  const reason = new DOMException('Synthetic local cancellation', 'AbortError');
  const request = transport.fetch(firstOrigin, { credentials: 'omit', signal: controller.signal });
  let rejection: unknown;
  const completed = request.catch((error: unknown) => { rejection = error; });
  await turn();
  controller.abort(reason);
  await turn();
  try {
    assert.equal(rejection, reason, 'Fetch must settle locally while native IPC is still pending');
  } finally {
    response.resolve(reply());
    cancellation.resolve();
    await completed;
  }
});

test('aborting a pending streaming request body cancels its source without native dispatch', async () => {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    cancel() { sourceCancelled = true; },
  });
  const native = bridge();
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const controller = new AbortController();
  const reason = new DOMException('Cancel the request body', 'AbortError');
  const input = new Request(firstOrigin, { method: 'POST', credentials: 'omit', body, duplex: 'half', signal: controller.signal } as RequestInit);
  let rejection: unknown;
  const completed = transport.fetch(input).catch((error: unknown) => { rejection = error; });
  await turn();
  controller.abort(reason);
  await turn();
  try {
    assert.equal(rejection, reason);
    assert.equal(sourceCancelled, true);
    assert.equal(native.calls.some((call) => call.command === 'account_http'), false);
  } finally {
    if (!sourceCancelled) bodyController.close();
    await completed;
  }
});

test('an oversized streaming request body is stopped before buffering or IPC can continue', async () => {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); },
    cancel() { sourceCancelled = true; },
  });
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const input = new Request(firstOrigin, { method: 'POST', credentials: 'omit', body, duplex: 'half' } as RequestInit);
  let rejection: unknown;
  const completed = transport.fetch(input).catch((error: unknown) => { rejection = error; });
  await turn();
  try {
    assert.ok(rejection instanceof NativeTransportError);
    assert.equal(rejection.code, 'request_too_large');
    assert.equal(sourceCancelled, true);
    assert.equal(native.calls.some((call) => call.command === 'account_http'), false);
  } finally {
    if (!sourceCancelled) bodyController.close();
    await completed;
  }
});

test('a request body exactly at the native ten mebibyte limit is still sent intact', async () => {
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const body = new Uint8Array(10 * 1024 * 1024);
  body[0] = 255;
  body[body.length - 1] = 128;
  await transport.fetch(firstOrigin, { method: 'POST', credentials: 'omit', body });
  const payload = native.calls.find((call) => call.command === 'account_http')!.args;
  const decoded = Buffer.from(String(payload.body), 'base64');
  assert.equal(decoded.byteLength, body.byteLength);
  assert.equal(decoded[0], 255);
  assert.equal(decoded.at(-1), 128);
});

test('account removal rejects its pending request as AbortError while another account completes', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<ReturnType<typeof reply>>>>();
  const native = bridge(({ command, args }) => {
    const id = String(args.accountId);
    if (command === 'account_http') {
      const request = deferred<ReturnType<typeof reply>>();
      pending.set(id, request);
      return request.promise;
    }
    if (command === 'remove_account_transport') pending.get(id)?.reject({ code: 'request_cancelled', message: 'The account request was cancelled.' });
  });
  const first = new NativeAccountTransport('account-one', native.invoke);
  const second = new NativeAccountTransport('account-two', native.invoke);
  await first.allowOrigins([firstOrigin]);
  await second.allowOrigins([secondOrigin]);
  const firstRequest = first.fetch(firstOrigin, { credentials: 'omit' });
  const rejected = assert.rejects(firstRequest, { name: 'AbortError' });
  const secondRequest = second.fetch(secondOrigin, { credentials: 'omit' });
  await turn();
  await first.close();
  await rejected;
  pending.get('account-two')!.resolve(reply({ body: new TextEncoder().encode('Account two is still active') }));
  assert.equal(await (await secondRequest).text(), 'Account two is still active');
  assert.deepEqual(native.calls.filter((call) => call.command === 'remove_account_transport').map((call) => call.args), [{ accountId: 'account-one' }]);
});

test('closing immediately prevents new requests even while native removal is pending', async () => {
  const removal = deferred<void>();
  const native = bridge(({ command }) => command === 'remove_account_transport' ? removal.promise : command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const closing = transport.close();
  const rejected = assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit' }), { code: 'transport_closed' });
  removal.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 0);
  await transport.close();
  assert.equal(native.calls.filter((call) => call.command === 'remove_account_transport').length, 1);
});

test('closing an account promptly rejects active Fetch calls while native removal is pending', async () => {
  const response = deferred<ReturnType<typeof reply>>();
  const removal = deferred<void>();
  const native = bridge(({ command }) => command === 'account_http' ? response.promise : command === 'remove_account_transport' ? removal.promise : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  let rejection: unknown;
  const completed = transport.fetch(firstOrigin, { credentials: 'omit' }).catch((error: unknown) => { rejection = error; });
  await turn();
  const closing = transport.close();
  await turn();
  try {
    assert.ok(rejection instanceof DOMException);
    assert.equal(rejection.name, 'AbortError');
  } finally {
    response.resolve(reply());
    removal.resolve();
    await Promise.all([completed, closing]);
  }
});

test('a native reply that wins the removal race is discarded after the account closes', async () => {
  const response = deferred<ReturnType<typeof reply>>();
  const native = bridge(({ command }) => command === 'account_http' ? response.promise : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const request = transport.fetch(firstOrigin, { credentials: 'omit' });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await turn();
  await transport.close();
  response.resolve(reply({ body: new TextEncoder().encode('Arrived after logout') }));
  await rejected;
});

test('closing while a request body is being read cancels the source before native dispatch', async () => {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; }, cancel() { sourceCancelled = true; } });
  const native = bridge(({ command }) => command === 'account_http' ? reply() : undefined);
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const input = new Request(firstOrigin, { method: 'POST', credentials: 'omit', body, duplex: 'half' } as RequestInit);
  let rejection: unknown;
  const completed = transport.fetch(input).catch((error: unknown) => { rejection = error; });
  await turn();
  await transport.close();
  await turn();
  try {
    assert.ok(rejection instanceof NativeTransportError);
    assert.equal(rejection.code, 'transport_closed');
    assert.equal(sourceCancelled, true);
    assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 0);
  } finally {
    if (!sourceCancelled) bodyController.close();
    await completed;
  }
});

test('close waits for configuration cleanup and cannot resurrect a native account', async () => {
  const configuration = deferred<void>();
  let configured = false;
  const native = bridge(async ({ command }) => {
    if (command === 'configure_account_transport') { await configuration.promise; configured = true; }
    if (command === 'remove_account_transport') configured = false;
  });
  const transport = new NativeAccountTransport('account-one', native.invoke);
  const attempt = transport.allowOrigins([firstOrigin]);
  const rejected = assert.rejects(attempt, { code: 'transport_closed' });
  const queuedAttempt = transport.allowOrigins([secondOrigin]);
  const queuedRejected = assert.rejects(queuedAttempt, { code: 'transport_closed' });
  await turn();
  const closing = transport.close();
  configuration.resolve();
  await Promise.all([closing, rejected, queuedRejected]);
  assert.equal(configured, false);
  await assert.rejects(transport.allowOrigins([secondOrigin]), { code: 'transport_closed' });
  await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit' }), { code: 'transport_closed' });
  assert.equal(native.calls.filter((call) => call.command === 'configure_account_transport').length, 1);
});

test('native error messages and request secrets do not reach user-facing errors', async () => {
  const secret = 'synthetic-secret-not-for-display';
  const native = bridge(({ command }) => {
    if (command === 'account_http') throw { code: 'connection_failed', message: `https://user:${secret}@first.example.test Bearer ${secret}` };
  });
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit' }), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal((error as TypeError & { code: string }).code, 'connection_failed');
    assert.equal(safeError(error).includes(secret), false);
    return true;
  });
  assert.equal(safeError(new Error(secret)).includes(secret), false);
});

test('Fetch-compatible native errors let default Skype discovery reach its external endpoint', async () => {
  const internal = 'https://lyncdiscoverinternal.example.test';
  const external = 'https://lyncdiscover.example.test';
  for (const code of ['connection_failed', 'request_failed', 'request_timeout']) {
    const native = bridge(({ command, args }) => {
      if (command !== 'account_http') return;
      if (new URL(String(args.url)).origin === internal) throw { code, message: 'Sensitive native diagnostics are omitted' };
      return reply({ url: `${external}/`, body: new TextEncoder().encode(JSON.stringify({ _links: { applications: { href: '/advertised-applications' } } })) });
    });
    const transport = new NativeAccountTransport('discovery-account', native.invoke);
    await transport.allowOrigins([internal, external]);
    const client = new SkypeForHoo({ sipAddress: 'alex@example.test', auth: bearerAuth('synthetic-token'), fetch: transport.fetch });
    const discovered = await client.discover();
    assert.equal(discovered.applicationsUrl, `${external}/advertised-applications`);
    assert.deepEqual(native.calls.filter((call) => call.command === 'account_http').map((call) => call.args.url), [`${internal}/`, `${external}/`]);
  }
});

test('explicit account or origin boundary errors stop discovery without trying another endpoint', async () => {
  const origins = ['https://lyncdiscoverinternal.example.test', 'https://lyncdiscover.example.test'];
  const native = bridge(({ command }) => {
    if (command === 'account_http') throw { code: 'origin_not_allowed', message: 'The origin is not approved.' };
  });
  const transport = new NativeAccountTransport('discovery-account', native.invoke);
  await transport.allowOrigins(origins);
  const client = new SkypeForHoo({ sipAddress: 'alex@example.test', auth: bearerAuth('synthetic-token'), fetch: transport.fetch });
  await assert.rejects(client.discover(), (error: unknown) => error instanceof NativeTransportError && error.code === 'origin_not_allowed');
  assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 1);
});

test('native timeout, cancellation and policy errors preserve their distinct Fetch semantics', async () => {
  for (const [code, expectedName] of [['request_timeout', 'TimeoutError'], ['request_cancelled', 'AbortError'], ['forbidden_header', 'NativeTransportError'], ['response_too_large', 'NativeTransportError'], ['account_not_configured', 'NativeTransportError']] as const) {
    const native = bridge(({ command }) => {
      if (command === 'account_http') throw { code, message: 'Sensitive native diagnostic details must not be shown.' };
    });
    const transport = new NativeAccountTransport('account-one', native.invoke);
    await transport.allowOrigins([firstOrigin]);
    await assert.rejects(transport.fetch(firstOrigin, { credentials: 'omit' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, expectedName);
      assert.equal(error.message.includes('Sensitive'), false);
      if (error instanceof NativeTransportError) assert.equal(error.code, code);
      return true;
    });
    assert.equal(native.calls.filter((call) => call.command === 'account_http').length, 1);
  }
});

test('completed and failed requests detach caller and account cancellation listeners', async () => {
  for (const fail of [false, true]) {
    const native = bridge(({ command }) => {
      if (command !== 'account_http') return;
      if (fail) throw { code: 'connection_failed' };
      return reply();
    });
    const transport = new NativeAccountTransport('account-one', native.invoke);
    await transport.allowOrigins([firstOrigin]);
    const controller = new AbortController();
    const request = transport.fetch(firstOrigin, { credentials: 'omit', signal: controller.signal });
    if (fail) await assert.rejects(request, TypeError); else await request;
    controller.abort();
    await transport.close();
    await turn();
    assert.equal(native.calls.filter((call) => call.command === 'cancel_account_http').length, 0);
  }
});

test('failed cancellation acknowledgement and late native rejection cannot replace the caller reason', async () => {
  const response = deferred<ReturnType<typeof reply>>();
  const native = bridge(({ command }) => {
    if (command === 'account_http') return response.promise;
    if (command === 'cancel_account_http') throw { code: 'transport_unavailable', message: 'Synthetic cancellation acknowledgement failure' };
  });
  const transport = new NativeAccountTransport('account-one', native.invoke);
  await transport.allowOrigins([firstOrigin]);
  const controller = new AbortController();
  const reason = new DOMException('The caller stopped this request', 'AbortError');
  const request = transport.fetch(firstOrigin, { credentials: 'omit', signal: controller.signal });
  await turn();
  controller.abort(reason);
  await assert.rejects(request, (error: unknown) => error === reason);
  response.reject({ code: 'request_failed', message: 'Synthetic late IPC rejection' });
  await turn();
});
