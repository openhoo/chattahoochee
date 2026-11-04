import { TeamwireClient, TeamwireError, type TeamwireSession, type TeamwireContact, type TeamwireConversation, type TeamwireFeed, type TeamwireMessage } from '@openhoo/teamwire-sdk';
import { NativeTransportError, safeError } from '../lib/native-transport';
import type { AccountInput, Conversation } from '../model/types';
import { avatarColor, initials, scopedId, type AccountConnector, type ConnectorContext } from './types';

/** Human-account transport. The SDK owns both session and conversation encryption. */
export class TeamwireConnector implements AccountConnector {
  private context?: ConnectorContext;
  private session?: TeamwireSession;
  private lifetime = new AbortController();
  private readonly contacts = new Map<string, TeamwireContact>();
  private readonly conversations = new Map<string, TeamwireConversation>();
  private readonly messageAliases = new Map<string, string>();
  private readonly unmatchedOutgoing = new Set<string>();
  private readonly operations = new Map<string, string>();
  private readonly unsubscribed = new Set<string>();
  private readonly latestIncoming = new Map<string, { messageId: string; timestamp: string }>();
  private readonly histories = new Map<string, Promise<void>>();
  private removeAbort?: () => void;
  private polling?: Promise<void>;
  private initialization?: Promise<void>;
  private disconnection?: Promise<void>;

  connect(input: AccountInput, context: ConnectorContext): Promise<void> {
    if (this.context || this.initialization || this.disconnection) {
      return Promise.reject(new NativeTransportError('already_connected', 'Disconnect the current Teamwire session before connecting again.'));
    }
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    this.context = context;
    const abort = () => lifetime.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => context.signal.removeEventListener('abort', abort);
    if (context.signal.aborted) abort();
    const operation = this.initialize(input, context, lifetime).finally(() => {
      if (this.initialization === operation) this.initialization = undefined;
    });
    this.initialization = operation;
    return operation;
  }

  private async initialize(input: AccountInput, context: ConnectorContext, lifetime: AbortController): Promise<void> {
    lifetime.signal.throwIfAborted();
    const server = input.server?.trim() ?? '';
    let client: TeamwireClient;
    try { client = new TeamwireClient({ origin: server.includes('://') ? server : `https://${server}`, fetch: context.fetch }); }
    catch (error) {
      if (error instanceof TeamwireError && error.code === 'INVALID_ORIGIN') throw new NativeTransportError('invalid_origin', error.message);
      throw error;
    }
    this.session = await client.loginPassword({ email: input.address, password: input.password }, { signal: lifetime.signal });
    const contacts = await this.session.getContacts({ signal: lifetime.signal });
    for (const contact of contacts) {
      this.contacts.set(contact.id, contact);
      context.emit({ type: 'contact', contact: {
        id: scopedId(context.accountId, contact.id), accountId: context.accountId, provider: 'teamwire', nativeId: contact.id,
        name: contact.displayName, address: contact.email || contact.id, initials: initials(contact.displayName), color: avatarColor(contact.id), presence: 'unknown',
      } });
    }
    await this.refreshConversations();
    const feed = await this.session.getFeed({ signal: lifetime.signal });
    await this.applyFeed(feed, true);
    const newest = [...this.conversations.values()].filter(conversation => !this.unsubscribed.has(conversation.id))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 8);
    await Promise.all(newest.map((conversation) => this.loadHistory(conversation.id)));
    this.polling = this.consume(feed.cursor).catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        lifetime.abort();
        context.emit({ type: 'error', message: `Teamwire synchronization stopped. ${safeError(error)} Disconnect and reconnect to resume.` });
      }
    });
  }

  private requireSession(): TeamwireSession {
    this.lifetime.signal.throwIfAborted();
    if (!this.session) throw new Error('Teamwire is not connected.');
    return this.session;
  }

  private async refreshConversations(): Promise<void> {
    const conversations = await this.requireSession().getConversations({ signal: this.lifetime.signal });
    for (const conversation of conversations) this.emitConversation(conversation);
  }

  private emitConversation(native: TeamwireConversation): Conversation {
    const subscribed = !this.unsubscribed.has(native.id);
    this.conversations.set(native.id, subscribed ? native : { ...native, canSend: false });
    const participantNames = native.participantIds.filter((id) => id !== this.session?.userId).map((id) => this.contacts.get(id)?.displayName ?? id);
    const title = native.title || participantNames.join(', ') || 'Teamwire conversation';
    const conversation: Conversation = {
      id: scopedId(this.context!.accountId, native.id), accountId: this.context!.accountId, provider: 'teamwire', nativeId: native.id,
      title, initials: initials(title), color: avatarColor(native.id), participants: participantNames,
      preview: '', updatedAt: native.updatedAt ?? new Date(0).toISOString(), unread: 0, pinned: false, group: native.type !== '1to1', presence: 'unknown',
      capabilities: { sendMessages: subscribed && native.canSend, typing: false, markRead: subscribed, attachments: false, audio: false, video: false, screenSharing: false },
    };
    this.context!.emit({ type: 'conversation', conversation });
    return conversation;
  }

  private async emitMessage(native: TeamwireMessage, historical = false): Promise<void> {
    if (native.isSystem) return;
    if (!this.conversations.has(native.threadId)) await this.refreshConversations();
    if (!this.conversations.has(native.threadId)) return;
    const cid = typeof native.raw.cid === 'string' ? native.raw.cid : undefined;
    const outgoing = native.senderId === this.session?.userId;
    const aliasKey = scopedId(native.threadId, native.id);
    if (outgoing && cid && this.operations.get(cid) === native.threadId) this.messageAliases.set(aliasKey, cid);
    const alias = outgoing ? this.messageAliases.get(aliasKey) : undefined;
    if (outgoing && !alias) this.unmatchedOutgoing.add(aliasKey);
    const nativeId = alias ?? native.id;
    const body = native.decryption === 'decrypted' ? native.text : native.decryption === 'empty'
      ? '[Message with no supported text content]' : '[Encrypted message unavailable in this client]';
    if (!outgoing) {
      const previous = this.latestIncoming.get(native.threadId);
      if (!previous || previous.timestamp < native.timestamp) this.latestIncoming.set(native.threadId, { messageId: native.id, timestamp: native.timestamp });
    }
    this.context!.emit({ type: 'message', historical, message: {
      id: scopedId(this.context!.accountId, nativeId), accountId: this.context!.accountId,
      conversationId: scopedId(this.context!.accountId, native.threadId), senderId: native.senderId,
      senderName: outgoing ? 'You' : this.contacts.get(native.senderId)?.displayName ?? 'Teamwire contact',
      body, createdAt: native.timestamp, direction: outgoing ? 'outgoing' : 'incoming', delivery: outgoing ? 'accepted' : 'delivered',
    } });
  }

  private loadHistory(threadId: string): Promise<void> {
    if (this.unsubscribed.has(threadId)) return Promise.resolve();
    const existing = this.histories.get(threadId);
    if (existing) return existing;
    const operation = (async () => {
      const messages = await this.requireSession().getHistory(threadId, { days: 30, signal: this.lifetime.signal });
      for (const message of messages) await this.emitMessage(message, true);
    })();
    this.histories.set(threadId, operation);
    void operation.catch(() => { if (this.histories.get(threadId) === operation) this.histories.delete(threadId); });
    return operation;
  }

  async loadConversation(conversation: Conversation): Promise<void> { await this.loadHistory(conversation.nativeId); }

  private async applyFeed(feed: TeamwireFeed, historical = false): Promise<void> {
    for (const event of feed.events) {
      if (!['chats.leave', 'chats.join'].includes(event.type) || !Array.isArray(event.raw.chats)) continue;
      for (const id of event.raw.chats) {
        if (typeof id !== 'string' && typeof id !== 'number') continue;
        const threadId = String(id);
        if (event.type === 'chats.leave') {
          this.unsubscribed.add(threadId);
          const conversation = this.conversations.get(threadId);
          if (conversation) this.emitConversation(conversation);
        } else this.unsubscribed.delete(threadId);
      }
    }
    // Subscription reads return updates; absence alone cannot establish a leave.
    if (feed.events.length) await this.refreshConversations();
    for (const message of feed.messages) await this.emitMessage(message, historical);
  }

  private async consume(since: string): Promise<void> {
    for await (const feed of this.requireSession().watchFeed({ since, intervalMs: 10_000, signal: this.lifetime.signal })) {
      await this.applyFeed(feed);
    }
  }

  async sendMessage(conversation: Conversation, body: string, operationId: string): Promise<void> {
    if (this.unsubscribed.has(conversation.nativeId)) {
      throw new NativeTransportError('conversation_unavailable', 'You are no longer subscribed to this Teamwire conversation.');
    }
    this.operations.set(operationId, conversation.nativeId);
    const receipt = await this.requireSession().sendText(conversation.nativeId, body, { clientMessageId: operationId, signal: this.lifetime.signal });
    const aliasKey = scopedId(conversation.nativeId, receipt.id);
    this.messageAliases.set(aliasKey, operationId);
    const replacesMessageId = this.unmatchedOutgoing.delete(aliasKey) ? scopedId(this.context!.accountId, receipt.id) : undefined;
    // The native id may already have arrived through the feed. Reconcile it atomically.
    this.context!.emit({ type: 'message', replacesMessageId, message: {
      id: scopedId(this.context!.accountId, operationId), accountId: this.context!.accountId, conversationId: conversation.id,
      senderId: this.session!.userId, senderName: 'You', body, createdAt: receipt.timestamp, direction: 'outgoing', delivery: 'accepted',
    } });
  }

  async startConversation(address: string): Promise<void> {
    this.requireSession();
    const contact = [...this.contacts.values()].find((value) => value.id === address || value.email?.toLowerCase() === address.toLowerCase());
    const conversation = [...this.conversations.values()].find((value) => value.type === '1to1' && value.participantIds.includes(contact?.id ?? address));
    if (!conversation) throw new NativeTransportError('unsupported_operation', 'This preview can open existing Teamwire chats. Create a new chat in Teamwire, then reconnect here.');
    const normalized = this.emitConversation(conversation);
    this.context!.emit({ type: 'select-conversation', conversationId: normalized.id });
    await this.loadHistory(conversation.id);
  }

  async setTyping(): Promise<void> { /* No verified human-account typing operation yet. */ }

  async markRead(conversation: Conversation): Promise<void> {
    if (this.unsubscribed.has(conversation.nativeId)) return;
    await this.loadHistory(conversation.nativeId);
    const latest = this.latestIncoming.get(conversation.nativeId);
    if (latest) await this.requireSession().markRead(conversation.nativeId, { messageId: latest.messageId }, { signal: this.lifetime.signal });
  }

  disconnect(): Promise<void> {
    if (this.disconnection) return this.disconnection;
    this.lifetime.abort();
    this.removeAbort?.();
    this.removeAbort = undefined;
    const operation = (async () => {
      await this.initialization?.catch(() => {});
      try { await this.session?.logout({ signal: AbortSignal.timeout(5000) }); }
      finally {
        this.session?.close(); this.session = undefined;
        this.contacts.clear(); this.conversations.clear(); this.messageAliases.clear(); this.unmatchedOutgoing.clear(); this.operations.clear(); this.unsubscribed.clear(); this.latestIncoming.clear(); this.histories.clear();
        await this.polling;
        this.polling = undefined;
        this.context = undefined;
      }
    })().finally(() => { if (this.disconnection === operation) this.disconnection = undefined; });
    this.disconnection = operation;
    return operation;
  }
}
