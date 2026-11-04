import { invoke, isTauri } from '@tauri-apps/api/core';

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface NativeResponse { status: number; headers: [string, string][]; url: string; body: string; bodyEncoding: 'base64' }

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export class NativeTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeTransportError'; }
}

export function safeError(error: unknown): string {
  if (error instanceof NativeTransportError) return error.message;
  // Server error payloads, request URLs and credential-bearing challenge data are never displayed.
  if (error instanceof Error && error.name === 'AbortError') return 'The operation was cancelled.';
  if (error instanceof Error && error.name === 'MissingLinkError') return 'This server does not offer the requested operation.';
  if (error instanceof Error && error.name === 'UntrustedOriginError') return 'The service address was not approved.';
  if (error instanceof Error && error.name === 'HttpError' && 'status' in error) return `The service returned HTTP ${String(error.status)}.`;
  return 'The connection could not complete. Check your account settings and service availability.';
}

export const desktopAvailable = () => isTauri();

/** A Fetch-compatible bridge. Credentials and tokens remain in memory; there is no browser fallback. */
export class NativeAccountTransport {
  private readonly origins = new Set<string>();
  private configuration: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private transportClosed = false;
  constructor(readonly accountId: string, private readonly nativeInvoke: Invoke = invoke) {}

  private assertOpen(): void {
    if (this.transportClosed) throw new NativeTransportError('transport_closed', 'This account transport has been closed.');
  }

  async allowOrigins(origins: readonly string[]): Promise<void> {
    this.assertOpen();
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes('*') || url.origin !== origin) throw new TypeError('Exact HTTPS service origins are required.');
    }
    const requested = [...origins];
    const configuration = this.configuration.then(async () => {
      this.assertOpen();
      const next = new Set([...this.origins, ...requested]);
      await this.nativeInvoke('configure_account_transport', { accountId: this.accountId, origins: [...next] });
      this.assertOpen();
      for (const origin of next) this.origins.add(origin);
    });
    // A rejected approval must not prevent a later, independent approval from running.
    this.configuration = configuration.catch(() => {});
    await configuration;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    this.assertOpen();
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || !this.origins.has(url.origin)) throw new NativeTransportError('unapproved_origin', 'Approve this service address before connecting.');
    if (request.credentials !== 'omit') throw new NativeTransportError('ambient_credentials', 'Native account requests must omit ambient credentials.');
    const body = request.body ? bytesToBase64(new Uint8Array(await request.arrayBuffer())) : undefined;
    request.signal.throwIfAborted();
    this.assertOpen();
    const requestId = crypto.randomUUID();
    const abort = () => { void this.nativeInvoke('cancel_account_http', { accountId: this.accountId, requestId }).catch(() => {}); };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      const reply = await this.nativeInvoke<NativeResponse>('account_http', {
        accountId: this.accountId, requestId, url: request.url, method: request.method,
        headers: [...request.headers.entries()], ...(body === undefined ? {} : { body, bodyEncoding: 'base64' }),
      });
      request.signal.throwIfAborted();
      if (this.transportClosed) throw new DOMException('The operation was cancelled.', 'AbortError');
      const headers = new Headers();
      for (const [name, value] of reply.headers) headers.append(name, value);
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(reply.status);
      const response = new Response(empty ? null : base64ToBytes(reply.body), { status: reply.status, headers });
      Object.defineProperty(response, 'url', { value: reply.url });
      return response;
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (this.transportClosed) throw new DOMException('The operation was cancelled.', 'AbortError');
      if (error instanceof NativeTransportError) throw error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'network_error';
      if (code === 'request_cancelled') throw new DOMException('The operation was cancelled.', 'AbortError');
      if (code === 'request_timeout') throw new DOMException('The account request timed out.', 'TimeoutError');
      if (['connection_failed', 'request_failed', 'network_error'].includes(code)) {
        // Fetch network failures are TypeError; discovery uses that distinction to try its next endpoint.
        throw Object.assign(new TypeError('The native network request could not be completed.'), { code });
      }
      throw new NativeTransportError(code, 'The native connection failed. Check the service address and network.');
    } finally {
      request.signal.removeEventListener('abort', abort);
    }
  };

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.transportClosed = true;
    this.origins.clear();
    // Remove after configuration settles so a late approval cannot recreate native scope.
    this.closing = this.configuration.then(() => this.nativeInvoke<void>('remove_account_transport', { accountId: this.accountId }));
    return this.closing;
  }
}
