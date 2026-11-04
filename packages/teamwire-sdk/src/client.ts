import { createEphemeralKey, deriveSessionSecret, TeamwireCrypto } from './crypto';
import {
  TeamwireHttpError,
  TeamwireProtocolError,
  TeamwireSessionClosedError,
  TeamwireUnsupportedConversationError,
  UnsupportedAuthError,
} from './errors';
import {
  array, decodeCursor, encodeCursor, field, identifier, identifiers, initialCursor,
  isoTimestamp, optionalString, publicRecord, record, requiredTimestamp, TeamwireTransport,
} from './protocol';
import type {
  TeamwireClientOptions, TeamwireContact, TeamwireConversation, TeamwireEvent,
  TeamwireFeed, TeamwireHistoryOptions, TeamwireMessage, TeamwirePasswordLogin,
  TeamwirePreferences, TeamwireRecord, TeamwireRequestOptions, TeamwireSendOptions,
  TeamwireSendReceipt, TeamwireSyncOptions, TeamwireWatchOptions,
} from './types';

export class TeamwireClient {
  readonly origin: string;
  #transport: TeamwireTransport;

  constructor(options: TeamwireClientOptions) {
    const implementation = options.crypto ?? globalThis.crypto;
    const fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetch) throw new TeamwireProtocolError('A Fetch-compatible transport is required.');
    this.#transport = new TeamwireTransport(options.origin, fetch, new TeamwireCrypto(implementation));
    this.origin = this.#transport.origin;
  }

  /** Version information is an unauthenticated read; no account autodiscovery is assumed. */
  async getSupportedApiVersions(options: TeamwireRequestOptions = {}): Promise<Array<string | number>> {
    const { data } = await this.#transport.request('/api_versions/?format=json', { plain: true, signal: options.signal });
    const versions = array(record(data).versions, 'API versions');
    if (!versions.every(value => typeof value === 'string' || typeof value === 'number')) {
      throw new TeamwireProtocolError('Invalid Teamwire API versions.');
    }
    return versions as Array<string | number>;
  }

  async loginPassword(credentials: TeamwirePasswordLogin, options: TeamwireRequestOptions = {}): Promise<TeamwireSession> {
    options.signal?.throwIfAborted();
    const email = credentials.email.trim().toLowerCase();
    if (!email || !email.includes('@') || !credentials.password) {
      throw new UnsupportedAuthError('An email address and password are required for password login.');
    }
    const { crypto } = this.#transport;
    const ephemeral = createEphemeralKey();
    try {
      const { data } = await this.#transport.request('/u/sessions/', {
        method: 'POST',
        body: JSON.stringify({ client_pubkey: ephemeral.publicKey }),
        plain: true,
        signal: options.signal,
      });
      const challenge = record(data, 'session challenge');
      const sessionId = identifier(field(challenge, 'session_id', 'sessionId'), 'session challenge');
      const serverKey = optionalString(field(challenge, 'server_pubkey', 'serverPubkey'));
      if (!serverKey) throw new UnsupportedAuthError();
      const key = await crypto.importSecret(deriveSessionSecret(ephemeral.secretKey, serverKey));
      const payload = {
        email_hash: await crypto.sha256(email),
        password: credentials.password,
        ...(credentials.registrationToken ? { registration_token: credentials.registrationToken } : {}),
        ...(credentials.auditInfo ? { audit_info: credentials.auditInfo } : {}),
      };
      const authenticated = await this.#transport.request(`/u/login/${encodeURIComponent(sessionId)}/`, {
        method: 'POST',
        body: await crypto.encrypt(JSON.stringify(payload), key),
        key,
        signal: options.signal,
      });
      const user = record(authenticated.data, 'login response');
      const from = identifier(field(user, 'from_id', 'fromId'), 'session identity');
      const userId = identifier(field(user, 'owner_id', 'ownerId'), 'user identity');
      return new TeamwireSession(this.#transport, key, from, userId);
    } catch (error) {
      if (error instanceof TeamwireProtocolError) throw new UnsupportedAuthError();
      if (error instanceof TeamwireHttpError && [404, 405, 419].includes(error.status)) {
        throw new UnsupportedAuthError(error.status === 419
          ? 'This account requires a password reset through a supported Teamwire client.'
          : undefined);
      }
      throw error;
    } finally { ephemeral.secretKey.fill(0); }
  }
}

interface CachedConversation { canSend: boolean; key?: CryptoKey; version: number }

/** Session keys remain in memory and are never included in normalized records. */
export class TeamwireSession {
  readonly userId: string;
  readonly origin: string;
  #transport: TeamwireTransport;
  #key: CryptoKey | undefined;
  #from: string;
  #closed = false;
  #conversations = new Map<string, CachedConversation>();
  #contacts = new Map<string, TeamwireContact>();
  #unsubscribed = new Set<string>();
  #lifetime = new AbortController();

  /** Sessions are normally created by TeamwireClient.loginPassword(). */
  constructor(transport: TeamwireTransport, key: CryptoKey, from: string, userId: string) {
    this.#transport = transport;
    this.#key = key;
    this.#from = from;
    this.userId = userId;
    this.origin = transport.origin;
  }

  #activeKey(): CryptoKey {
    if (this.#closed || !this.#key) throw new TeamwireSessionClosedError();
    return this.#key;
  }

  async #request(path: string, options: {
    method?: string; payload?: unknown; headers?: Record<string, string>; signal?: AbortSignal; raw?: boolean;
  } = {}): Promise<{ data: unknown; response: Response }> {
    const key = this.#activeKey();
    const cancellation = combineSignals(this.#lifetime.signal, options.signal);
    try {
      cancellation.signal.throwIfAborted();
      const body = options.payload === undefined ? undefined : await this.#transport.crypto.encrypt(JSON.stringify(options.payload), key);
      this.#activeKey();
      const result = await this.#transport.request(path, {
        method: options.method, body, headers: options.headers, from: this.#from,
        key, signal: cancellation.signal, raw: options.raw,
      });
      this.#activeKey();
      return result;
    } finally { cancellation.dispose(); }
  }

  async getContacts(options: TeamwireRequestOptions = {}): Promise<TeamwireContact[]> {
    const { data } = await this.#request('/contacts', { method: 'POST', signal: options.signal });
    const contacts = array(record(data).users, 'contacts').map(value => {
      const user = record(value, 'contact');
      const id = identifier(user.id, 'contact');
      const firstName = optionalString(field(user, 'first_name', 'firstName')) ?? '';
      const lastName = optionalString(field(user, 'last_name', 'lastName')) ?? '';
      const profile = user.profile && typeof user.profile === 'object' && !Array.isArray(user.profile)
        ? user.profile as TeamwireRecord : {};
      const email = optionalString(user.email) ?? optionalString(profile.email);
      return { id, firstName, lastName, displayName: [firstName, lastName].filter(Boolean).join(' ') || email || id, email, raw: publicRecord(user) };
    });
    this.#contacts = new Map(contacts.map(contact => [contact.id, contact]));
    return contacts;
  }

  async getPreferences(options: TeamwireRequestOptions = {}): Promise<TeamwirePreferences> {
    const { data } = await this.#request('/u/preferences/', { signal: options.signal });
    const raw = record(data, 'preferences');
    return {
      favouriteChatIds: identifiers(field(raw, 'favourite_chats', 'favouriteChats')),
      unreadChatIds: identifiers(field(raw, 'unread_chats', 'unreadChats')),
      mutedChatIds: identifiers(field(raw, 'muted_chats', 'mutedChats')),
      archivedChatIds: identifiers(field(raw, 'archived_chats', 'archivedChats')),
      raw: publicRecord(raw),
    };
  }

  async #cacheConversations(values: unknown[]): Promise<TeamwireConversation[]> {
    const normalized: TeamwireConversation[] = [];
    const updates: Array<[string, CachedConversation]> = [];
    for (const value of values) {
      this.#activeKey();
      const raw = record(value, 'subscription');
      const id = identifier(raw.tid, 'conversation');
      const info = record(field(raw, 'thread_info', 'threadInfo'), 'conversation details');
      const members = record(raw.members, 'conversation members');
      const versionValue = field(raw, 'chat_v', 'chatV');
      const version = typeof versionValue === 'number' ? versionValue : versionValue === undefined ? 0 : Number.NaN;
      const secret = optionalString(raw.col);
      const supportedVersion = Number.isFinite(version) && version <= 0 && !this.#unsubscribed.has(id);
      const key = secret && supportedVersion ? await this.#transport.crypto.importSecret(secret) : undefined;
      const participantIds = identifiers(members.users);
      const type = info.type === '1to1' || info.type === 'group' ? info.type : 'unknown';
      let title = optionalString(info.title) ?? '';
      if (title && isEncryptedEnvelope(title)) {
        try { title = key ? await this.#transport.crypto.decrypt(title, key) : ''; }
        catch { title = ''; }
      }
      if (!title && type === '1to1') {
        title = participantIds.filter(member => member !== this.userId)
          .map(member => this.#contacts.get(member)?.displayName ?? member).join(', ');
      }
      const allowed = field(info, 'allow_sending', 'allowSending') ?? field(info, 'allow_post', 'allowPost');
      const closed = field(info, 'is_closed', 'isClosed') === true;
      const admins = identifiers(info.admins);
      const conversation: TeamwireConversation = {
        id, type, title,
        participantIds,
        groupIds: identifiers(members.groups ?? members.circles),
        roleIds: identifiers(members.roles),
        updatedAt: isoTimestamp(raw.ts),
        canSend: Boolean(key) && type !== 'unknown' && !closed && (allowed !== false || admins.includes(this.userId)),
        raw: publicRecord(raw),
      };
      this.#activeKey();
      updates.push([id, { canSend: conversation.canSend, key, version }]);
      normalized.push(conversation);
    }
    this.#activeKey();
    for (const [id, cached] of updates) this.#conversations.set(id, cached);
    return normalized;
  }

  async getConversations(options: TeamwireSyncOptions = {}): Promise<TeamwireConversation[]> {
    const { data, response } = await this.#request('/u/subscriptions/?legacy_circle_ids=true', {
      headers: { ETag: encodeCursor(options.since ?? initialCursor()) }, signal: options.signal,
    });
    if (response.status === 304) return [];
    return this.#cacheConversations(array(data, 'subscriptions'));
  }

  async #loadMissingConversations(ids: string[], options: TeamwireRequestOptions): Promise<void> {
    const missing = [...new Set(ids)].filter(id => !this.#conversations.has(id) && !this.#unsubscribed.has(id));
    if (!missing.length) return;
    const { data } = await this.#request('/u/subscriptions/matching_ids?legacy_circle_ids=true', {
      method: 'POST', payload: { thread_ids: missing }, signal: options.signal,
    });
    await this.#cacheConversations(array(record(data).subscriptions, 'matching subscriptions'));
  }

  async #messages(values: unknown[], options: TeamwireRequestOptions): Promise<TeamwireMessage[]> {
    const rows = values.map(value => record(value, 'message'));
    const userRows = rows.filter(row => row.from !== 'sys');
    await this.#loadMissingConversations(userRows.map(row => identifier(row.tid, 'message conversation')), options);
    const result: TeamwireMessage[] = [];
    for (const raw of rows) {
      // Global system events have no conversation/message identity and are returned in feed.events.
      if (raw.from === 'sys' && (raw.mid === undefined || raw.tid === undefined || !isoTimestamp(raw.ts))) continue;
      const id = identifier(raw.mid, 'message');
      const threadId = identifier(raw.tid, 'message conversation');
      const senderId = identifier(raw.from, 'message sender');
      const timestamp = requiredTimestamp(raw.ts);
      const isSystem = senderId === 'sys';
      const cached = this.#conversations.get(threadId);
      let text = '';
      let decryption: TeamwireMessage['decryption'] = 'empty';
      const ciphertext = optionalString(raw.m);
      if (!isSystem && ciphertext) {
        if (cached && (!Number.isFinite(cached.version) || cached.version > 0)) decryption = 'unsupported';
        else if (!cached?.key) decryption = 'missing-key';
        else {
          try { text = await this.#transport.crypto.decrypt(ciphertext, cached.key); decryption = 'decrypted'; }
          catch { decryption = 'failed'; }
        }
      }
      result.push({ id, threadId, senderId, text, timestamp, isSystem, decryption, raw: publicRecord(raw) });
    }
    this.#activeKey();
    return result;
  }

  async getHistory(threadId: string, options: TeamwireHistoryOptions = {}): Promise<TeamwireMessage[]> {
    const id = identifier(threadId, 'conversation');
    const { data, response } = await this.#request(`/t/${encodeURIComponent(id)}/`, {
      headers: { ETag: encodeCursor(options.since ?? initialCursor(options.days)) }, signal: options.signal,
    });
    if (response.status === 304) return [];
    const rows = array(data, 'history');
    for (const value of rows) {
      const row = record(value, 'history message');
      if (row.tid !== undefined && identifier(row.tid, 'history conversation') !== id) {
        throw new TeamwireProtocolError('The history response refers to a different conversation.');
      }
    }
    return this.#messages(rows, options);
  }

  async sendText(threadId: string, text: string, options: TeamwireSendOptions = {}): Promise<TeamwireSendReceipt> {
    if (typeof text !== 'string' || !text.trim()) throw new TeamwireProtocolError('A nonempty text message is required.');
    const id = identifier(threadId, 'conversation');
    if (this.#unsubscribed.has(id)) throw new TeamwireUnsupportedConversationError();
    await this.#loadMissingConversations([id], options);
    const cached = this.#conversations.get(id);
    if (!cached?.key || !cached.canSend) throw new TeamwireUnsupportedConversationError();
    const clientMessageId = options.clientMessageId ? identifier(options.clientMessageId, 'client message') : this.#transport.crypto.requestId();
    const message = await this.#transport.crypto.encrypt(text, cached.key);
    const { data } = await this.#request('/t', {
      method: 'POST',
      payload: {
        cid: clientMessageId, msg: message, tid: id, isAlert: false,
        notification: { text: 'Encrypted message' },
        ...(options.replyTo ? { reply_to: identifier(options.replyTo, 'reply message') } : {}),
      },
      signal: options.signal,
    });
    const raw = record(data, 'send receipt');
    const receiptThread = identifier(raw.tid, 'receipt conversation');
    if (receiptThread !== id) throw new TeamwireProtocolError('The message receipt refers to a different conversation.');
    return {
      id: identifier(raw.mid, 'receipt message'), threadId: receiptThread,
      timestamp: requiredTimestamp(raw.ts), clientMessageId, delivery: 'accepted', raw: publicRecord(raw),
    };
  }

  async getFeed(options: TeamwireSyncOptions = {}): Promise<TeamwireFeed> {
    const since = options.since ?? initialCursor();
    const requestStarted = new Date().toISOString();
    const { data, response } = await this.#request('/feed', { headers: { ETag: encodeCursor(since) }, signal: options.signal });
    // Retain the original cursor on a 304 without ETag so a race cannot skip events.
    const cursor = decodeCursor(response.headers.get('etag'), response.status === 304 ? since : requestStarted);
    if (response.status === 304) return { messages: [], events: [], readThreads: [], cursor, raw: {} };
    const raw = record(data, 'feed');
    const rows = array(raw.messages, 'feed messages');
    const systemRows = rows.map(value => record(value, 'feed event')).filter(value => value.from === 'sys');
    const events: TeamwireEvent[] = systemRows.map(value => ({
      type: optionalString(value.type) ?? 'unknown',
      threadId: value.tid === undefined ? undefined : identifier(value.tid),
      raw: publicRecord(value),
    }));
    // A feed may announce the first subscription or a replacement chat key.
    for (const event of systemRows) {
      if (event.type === 'chat.created' && event.col && field(event, 'thread_info', 'threadInfo') && event.members) {
        await this.#cacheConversations([event]);
      }
      if (event.type === 'chats.leave' && Array.isArray(event.chats)) {
        for (const id of identifiers(event.chats)) { this.#unsubscribed.add(id); this.#conversations.delete(id); }
      }
      if (event.type === 'chats.join' && Array.isArray(event.chats)) {
        for (const id of identifiers(event.chats)) { this.#unsubscribed.delete(id); this.#conversations.delete(id); }
      }
    }
    const messages = await this.#messages(rows, options);
    const readers = field(raw, 'read_threads', 'readThreads') ?? [];
    const readThreads = array(readers, 'read threads').map(value => {
      const row = record(value, 'read thread');
      return { threadId: identifier(row.tid), timestamp: requiredTimestamp(field(row, 'last_read_ts', 'lastReadTs')) };
    });
    return { messages, events, readThreads, cursor, raw: publicRecord(raw) };
  }

  /** timestamp is the time of reading, rather than the message creation time. */
  async markRead(threadId: string, message: { messageId: string; timestamp?: string }, options: TeamwireRequestOptions = {}): Promise<void> {
    const timestamp = requiredTimestamp(message.timestamp ?? new Date().toISOString());
    if (this.#unsubscribed.has(identifier(threadId))) throw new TeamwireUnsupportedConversationError();
    await this.#request(`/t/${encodeURIComponent(identifier(threadId))}/readers`, {
      method: 'POST', payload: { mid: identifier(message.messageId), mts: Date.parse(timestamp) }, signal: options.signal,
    });
  }

  /** An optional polling event stream; errors are surfaced and writes are never retried. */
  async *watchFeed(options: TeamwireWatchOptions = {}): AsyncGenerator<TeamwireFeed> {
    const intervalMs = options.intervalMs ?? 15_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 500) throw new TeamwireProtocolError('Feed polling interval must be at least 500 ms.');
    let since = options.since;
    const cancellation = combineSignals(this.#lifetime.signal, options.signal);
    try {
      while (!this.#closed && !options.signal?.aborted) {
        const feed = await this.getFeed({ since, signal: cancellation.signal });
        since = feed.cursor;
        yield feed;
        if (this.#closed) break;
        await pause(intervalMs, cancellation.signal);
      }
    } catch (error) {
      if (!this.#closed || options.signal?.aborted) throw error;
    } finally { cancellation.dispose(); }
  }

  /** Drop local session keys without contacting the server. */
  close(): void {
    this.#closed = true;
    this.#lifetime.abort(new TeamwireSessionClosedError());
    this.#key = undefined;
    this.#from = '';
    this.#conversations.clear();
    this.#contacts.clear();
    this.#unsubscribed.clear();
  }

  /** Local keys are cleared even when the server cannot confirm logout. */
  async logout(options: TeamwireRequestOptions = {}): Promise<void> {
    if (this.#closed) return;
    const key = this.#activeKey();
    const from = this.#from;
    this.close();
    await this.#transport.request('/u/logout', { method: 'POST', from, key, raw: true, signal: options.signal });
  }
}

function isEncryptedEnvelope(value: string): boolean {
  if (!/^[A-Za-z\d+/]+={0,2}$/.test(value)) return false;
  try { const length = atob(value).length; return length >= 64 && (length - 48) % 16 === 0; }
  catch { return false; }
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; abort: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    listeners.push({ signal, abort });
  }
  return { signal: controller.signal, dispose: () => { for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort); } };
}
