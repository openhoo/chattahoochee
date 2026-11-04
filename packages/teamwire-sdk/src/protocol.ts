import { TeamwireCrypto, toHex } from './crypto';
import { TeamwireError, TeamwireHttpError, TeamwireProtocolError } from './errors';
import type { TeamwireFetch, TeamwireRecord } from './types';

export function record(value: unknown, label = 'response'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamwireProtocolError(`Invalid Teamwire ${label}.`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TeamwireProtocolError(`Invalid Teamwire ${label}.`);
  return value;
}

export function field(value: TeamwireRecord, snake: string, camel = snake): unknown {
  return value[snake] ?? value[camel];
}

export function identifier(value: unknown, label = 'identifier'): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length === 0 || /[\x00-\x1f\x7f/\\?#]/.test(String(value)) || ['.', '..'].includes(String(value))) {
    throw new TeamwireProtocolError(`Invalid Teamwire ${label}.`);
  }
  return String(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

export function identifiers(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => identifier(item)) : [];
}

export function isoTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' && (typeof value !== 'string' || !validIsoTimestamp(value))) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function validIsoTimestamp(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts || /\s/.test(value)) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59
    && (parts[7] === undefined || (Number(parts[8]) <= 23 && Number(parts[9]) <= 59))
    && Number.isFinite(Date.parse(value));
}

export function requiredTimestamp(value: unknown): string {
  const timestamp = isoTimestamp(value);
  if (!timestamp) throw new TeamwireProtocolError('A Teamwire message has no valid timestamp.');
  return timestamp;
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new TeamwireProtocolError('The server did not return valid Teamwire JSON.'); }
}

/** Keep protocol records inspectable without exporting conversation key material. */
export function publicRecord(value: TeamwireRecord): TeamwireRecord {
  function withoutKeys(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(withoutKeys);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'col').map(([key, child]) => [key, withoutKeys(child)]));
    }
    return item;
  }
  return withoutKeys(value) as TeamwireRecord;
}

export function encodeCursor(value: string): string {
  if (typeof value !== 'string' || !validIsoTimestamp(value)) throw new TeamwireProtocolError('A valid ISO synchronization cursor is required.');
  return toHex(new TextEncoder().encode(value));
}

export function decodeCursor(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const hex = header.replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^(?:[\da-f]{2})+$/i.test(hex)) throw new TeamwireProtocolError('Invalid Teamwire synchronization ETag.');
  const value = new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16)));
  encodeCursor(value);
  return value;
}

export function initialCursor(days = 90): string {
  if (!Number.isFinite(days) || days < 0) throw new TeamwireProtocolError('History days must be a nonnegative number.');
  const date = new Date(Date.now() - days * 86_400_000);
  if (!Number.isFinite(date.getTime())) throw new TeamwireProtocolError('The history window exceeds the supported date range.');
  return date.toISOString();
}

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  from?: string;
  key?: CryptoKey;
  signal?: AbortSignal;
  plain?: boolean;
  raw?: boolean;
}

export class TeamwireTransport {
  readonly origin: string;
  constructor(origin: string, readonly fetch: TeamwireFetch, readonly crypto: TeamwireCrypto) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new TeamwireError('An explicit HTTPS Teamwire origin is required.', 'INVALID_ORIGIN'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new TeamwireError('Teamwire requires an HTTPS origin without credentials, a path, query or fragment.', 'INVALID_ORIGIN');
    }
    this.origin = parsed.origin;
  }

  async request(path: string, options: RequestOptions = {}): Promise<{ data: unknown; response: Response }> {
    options.signal?.throwIfAborted();
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new TeamwireProtocolError('Invalid API endpoint.');
    const url = new URL(`/v20${path}`, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/v20/')) throw new TeamwireProtocolError('Invalid API endpoint.');
    const headers = new Headers(options.headers);
    headers.set('X-Request-ID', this.crypto.requestId());
    headers.set('Accept', 'application/octet-stream, application/json');
    if (options.from) headers.set('From', options.from);
    if (options.body !== undefined) headers.set('Content-Type', 'application/octet-stream');
    const method = options.method ?? 'GET';
    const response = await this.fetch(url.href, {
      method,
      headers,
      body: options.body,
      signal: options.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    options.signal?.throwIfAborted();
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new TeamwireProtocolError('The Teamwire transport refused a redirect.');
    }
    if (response.status === 304 || response.status === 204) return { data: undefined, response };
    if (!response.ok) throw new TeamwireHttpError(response.status, method, path.split('?')[0]!);
    const text = await response.text();
    options.signal?.throwIfAborted();
    if (options.raw) return { data: undefined, response };
    if (options.plain) return { data: text ? parseJson(text) : undefined, response };
    if (!options.key) throw new TeamwireProtocolError('The response requires an established session.');
    const data = parseJson(await this.crypto.decrypt(text.trim(), options.key));
    options.signal?.throwIfAborted();
    return { data, response };
  }
}
