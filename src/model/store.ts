import { defaultDiscoveryUrls } from 'skypeforhoo';
import { NativeAccountTransport, desktopAvailable, safeError } from '../lib/native-transport';
import { SkypeConnector } from '../connectors/skype';
import { TeamwireConnector } from '../connectors/teamwire';
import { scopedId, type AccountConnector, type ConnectorEvent } from '../connectors/types';
import { demoSnapshot, emptySnapshot } from './demo';
import type { AccountInput, AppSnapshot, Conversation, MessageDelivery, Provider, Theme } from './types';

interface Connection { connector: AccountConnector; transport: NativeAccountTransport; lifetime: AbortController; setup?: Promise<void>; cleanup?: Promise<void> }
export interface StoreOptions {
  demo?: boolean;
  theme?: Theme;
  isDesktop?: () => boolean;
  connectorFactory?: (provider: Provider) => AccountConnector;
  transportFactory?: (accountId: string) => NativeAccountTransport;
}

export function mergeDelivery(previous: MessageDelivery, incoming: MessageDelivery, authoritative = false): MessageDelivery {
  if (previous === 'failed' && incoming === 'accepted' && authoritative) return incoming;
  if (incoming === 'failed' && (previous === 'delivered' || previous === 'read')) return previous;
  if (previous === 'failed' && (incoming === 'delivered' || incoming === 'read')) return incoming;
  const ranks = { pending: 0, accepted: 1, delivered: 2, read: 3, failed: 4 };
  return ranks[incoming] >= ranks[previous] ? incoming : previous;
}

export class MessengerStore {
  private state: AppSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly connections = new Map<string, Connection>();
  private readonly approvals = new Map<string, (allowed: boolean) => void>();
  private readonly typingSent = new Map<string, number>();

  constructor(private readonly options: StoreOptions = {}) {
    this.state = options.demo ? demoSnapshot(options.theme) : emptySnapshot(options.theme);
  }

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: AppSnapshot): void { this.state = next; for (const listener of this.listeners) listener(); }
  private notice(message: string, kind: 'error' | 'info' | 'success' = 'info'): void { this.publish({ ...this.state, notice: { id: crypto.randomUUID(), kind, message } }); }
  private cleanupConnection(connection: Connection): Promise<void> {
    if (connection.cleanup) return connection.cleanup;
    connection.lifetime.abort();
    connection.cleanup = (async () => {
      await connection.setup?.catch(() => {});
      try { await connection.connector.disconnect(); }
      finally { await connection.transport.close(); }
    })();
    return connection.cleanup;
  }
  private liveConnection(accountId: string): Connection | undefined {
    if (this.state.mode !== 'live' || this.state.accounts.find(account => account.id === accountId)?.status !== 'connected') return;
    const connection = this.connections.get(accountId);
    return connection?.lifetime.signal.aborted ? undefined : connection;
  }
  private failPendingMessages(accountId: string, error: string): AppSnapshot['messages'] {
    return Object.fromEntries(Object.entries(this.state.messages).map(([id, messages]) => [id, messages.map(message => message.accountId === accountId && message.delivery === 'pending' ? { ...message, delivery: 'failed' as const, error } : message)]));
  }
  readonly dismissNotice = () => this.publish({ ...this.state, notice: null });

  readonly setTheme = (theme: Theme) => { this.publish({ ...this.state, theme }); };
  readonly selectConversation = (id: string) => {
    const conversation = this.state.conversations.find((value) => value.id === id);
    if (!conversation) return;
    this.publish({ ...this.state, selectedConversationId: id, conversations: this.state.conversations.map((value) => value.id === id ? { ...value, unread: 0 } : value) });
    const connection = this.liveConnection(conversation.accountId);
    if (!connection) return;
    void connection.connector.loadConversation?.(conversation).catch(() => { if (this.liveConnection(conversation.accountId) === connection) this.notice('The conversation history could not be loaded.', 'error'); });
    if (conversation.capabilities.markRead) void connection.connector.markRead?.(conversation).catch(() => { if (this.liveConnection(conversation.accountId) === connection) this.notice('The read status could not be synchronized.', 'error'); });
  };

  readonly togglePinned = (id: string) => this.publish({ ...this.state, conversations: this.state.conversations.map((value) => value.id === id ? { ...value, pinned: !value.pinned } : value) });

  readonly enterDemo = () => {
    if (this.connections.size) { this.notice('Disconnect your accounts before opening the demo workspace.'); return; }
    this.publish(demoSnapshot(this.state.theme));
  };
  readonly exitDemo = () => { if (this.state.mode === 'demo') this.publish(emptySnapshot(this.state.theme)); };

  readonly approveOrigin = (id: string, allowed: boolean) => {
    this.approvals.get(id)?.(allowed);
    this.approvals.delete(id);
    this.publish({ ...this.state, originApprovals: this.state.originApprovals.filter((approval) => approval.id !== id) });
  };

  private async requestOrigin(accountId: string, origin: string, connection: Connection): Promise<boolean> {
    connection.lifetime.signal.throwIfAborted();
    const account = this.state.accounts.find((value) => value.id === accountId);
    if (!account) return false;
    const id = crypto.randomUUID();
    const allowed = await new Promise<boolean>((resolve) => {
      const abort = () => this.approveOrigin(id, false);
      connection.lifetime.signal.addEventListener('abort', abort, { once: true });
      this.approvals.set(id, (value) => { connection.lifetime.signal.removeEventListener('abort', abort); resolve(value); });
      this.publish({ ...this.state, originApprovals: [...this.state.originApprovals, { id, accountId, accountLabel: account.label, origin }] });
    });
    if (allowed && !connection.lifetime.signal.aborted) await connection.transport.allowOrigins([origin]);
    return allowed && !connection.lifetime.signal.aborted;
  }

  readonly connectAccount = async (input: AccountInput): Promise<void> => {
    if (this.state.mode === 'demo') { this.notice('Leave the demo workspace before connecting a real account.'); throw new Error('Leave the demo workspace first.'); }
    if (!(this.options.isDesktop ?? desktopAvailable)()) { this.notice('Open the desktop app to connect an account. The browser preview supports the demo workspace.', 'info'); throw new Error('Account connections require the desktop app.'); }
    if (!input.address.trim() || !input.password || (input.provider === 'teamwire' && !input.server?.trim())) throw new Error('Complete the required account fields.');
    let service: URL | undefined;
    if (input.server?.trim()) {
      try {
        const server = input.server.trim();
        service = new URL(server.includes('://') ? server : `https://${server}`);
        if (service.protocol !== 'https:' || service.username || service.password || service.search || service.hash || (input.provider === 'teamwire' && service.pathname !== '/')) throw new Error('Invalid service URL');
      } catch {
        throw new Error(input.provider === 'teamwire' ? 'Use a Teamwire HTTPS origin without a path, credentials, query or fragment.' : 'Use an HTTPS discovery URL without credentials, query or fragment.');
      }
    }
    const accountId = crypto.randomUUID();
    const label = input.label?.trim() || (input.provider === 'skype' ? 'Skype for Business' : 'Teamwire');
    const connector = this.options.connectorFactory?.(input.provider) ?? (input.provider === 'skype' ? new SkypeConnector() : new TeamwireConnector());
    const transport = this.options.transportFactory?.(accountId) ?? new NativeAccountTransport(accountId);
    const connection: Connection = { connector, transport, lifetime: new AbortController() };
    this.connections.set(accountId, connection);
    this.publish({ ...this.state, accounts: [...this.state.accounts, { id: accountId, provider: input.provider, label, address: input.address.trim(), ...(service ? { server: service.href } : {}), status: 'connecting' }] });
    try {
      const origins = input.provider === 'skype'
        ? (service ? [service.origin] : defaultDiscoveryUrls(input.address).map((url) => new URL(url).origin))
        : [service!.origin];
      connection.setup = (async () => {
        await transport.allowOrigins([...origins, ...(input.trustedOrigins ?? [])]);
        connection.lifetime.signal.throwIfAborted();
        await connector.connect({ ...input, ...(service ? { server: service.href } : {}) }, {
          accountId, fetch: transport.fetch, signal: connection.lifetime.signal,
          approveOrigin: (origin) => this.requestOrigin(accountId, origin, connection),
          emit: (event) => { if (!connection.lifetime.signal.aborted) this.receive(accountId, event); },
        });
      })();
      await connection.setup;
      connection.lifetime.signal.throwIfAborted();
      this.publish({ ...this.state, accounts: this.state.accounts.map((account) => account.id === accountId ? { ...account, status: account.status === 'error' ? 'error' : 'connected' } : account) });
    } catch (error) {
      const cancelled = connection.lifetime.signal.aborted;
      await this.cleanupConnection(connection).catch(() => {});
      this.connections.delete(accountId);
      if (cancelled || this.state.accounts.find(account => account.id === accountId)?.status === 'disconnected') return;
      const message = safeError(error);
      this.publish({ ...this.state, accounts: this.state.accounts.map((account) => account.id === accountId ? { ...account, status: 'error', error: message } : account), notice: { id: crypto.randomUUID(), kind: 'error', message } });
      throw new Error(message);
    }
  };

  readonly disconnectAccount = async (accountId: string): Promise<void> => {
    const connection = this.connections.get(accountId);
    // Account data remains scoped in memory, but sending is disabled after logout.
    this.publish({ ...this.state,
      accounts: this.state.accounts.map((account) => account.id === accountId ? { ...account, status: 'disconnected', error: undefined } : account),
      conversations: this.state.conversations.map((conversation) => conversation.accountId === accountId ? { ...conversation, capabilities: { ...conversation.capabilities, sendMessages: false, typing: false, markRead: false } } : conversation),
      messages: this.failPendingMessages(accountId, 'The account disconnected before delivery could be confirmed.'),
      typing: Object.fromEntries(Object.entries(this.state.typing).filter(([id]) => !this.state.conversations.some((value) => value.accountId === accountId && value.id === id))),
    });
    if (connection) {
      try { await this.cleanupConnection(connection); }
      catch { this.notice('The account was disconnected, but server logout could not be confirmed.', 'info'); }
      finally { this.connections.delete(accountId); }
    }
  };

  receive(accountId: string, event: ConnectorEvent): void {
    const account = this.state.accounts.find(value => value.id === accountId);
    if (this.state.mode !== 'live' || !account || account.status === 'disconnected') return;
    const state = this.state;
    if (event.type === 'conversation') {
      if (event.conversation.accountId !== accountId || event.conversation.provider !== account.provider || event.conversation.id !== scopedId(accountId, event.conversation.nativeId)) return;
      const previous = state.conversations.find((value) => value.id === event.conversation.id);
      const conversation = previous ? { ...event.conversation, pinned: previous.pinned, unread: previous.unread, preview: event.conversation.preview || previous.preview, updatedAt: previous.updatedAt > event.conversation.updatedAt ? previous.updatedAt : event.conversation.updatedAt } : event.conversation;
      this.publish({ ...state, conversations: previous ? state.conversations.map((value) => value.id === conversation.id ? conversation : value) : [...state.conversations, conversation], selectedConversationId: state.selectedConversationId ?? conversation.id });
    } else if (event.type === 'contact') {
      if (event.contact.accountId !== accountId || event.contact.provider !== account.provider || event.contact.id !== scopedId(accountId, event.contact.nativeId)) return;
      this.publish({ ...state, contacts: [...state.contacts.filter((value) => value.id !== event.contact.id), event.contact] });
    } else if (event.type === 'message') {
      const message = event.message;
      if (message.accountId !== accountId || !message.id.startsWith(`${encodeURIComponent(accountId)}::`) || !state.conversations.some((value) => value.id === message.conversationId && value.accountId === accountId)) return;
      const existing = state.messages[message.conversationId] ?? [];
      const previous = existing.find((value) => value.id === message.id) ?? existing.find((value) => value.id === event.replacesMessageId);
      const next = previous ? { ...message, body: message.body || previous.body, delivery: mergeDelivery(previous.delivery, message.delivery, true) } : message;
      const messages = [...existing.filter((value) => value.id !== message.id && value.id !== event.replacesMessageId), next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.publish({ ...state, messages: { ...state.messages, [message.conversationId]: messages }, conversations: state.conversations.map((conversation) => conversation.id === message.conversationId ? {
        ...conversation, preview: (messages.at(-1)?.createdAt ?? '') >= conversation.updatedAt ? messages.at(-1)?.body || conversation.preview : conversation.preview, updatedAt: (messages.at(-1)?.createdAt ?? '') > conversation.updatedAt ? messages.at(-1)!.createdAt : conversation.updatedAt,
        unread: conversation.unread + (!previous && !event.historical && message.direction === 'incoming' && state.selectedConversationId !== conversation.id ? 1 : 0),
      } : conversation) });
    } else if (event.type === 'delivery') {
      const conversation = state.conversations.find((value) => value.id === event.conversationId && value.accountId === accountId);
      if (!conversation) return;
      this.publish({ ...state, messages: { ...state.messages, [event.conversationId]: (state.messages[event.conversationId] ?? []).map((message) => message.id === event.messageId ? { ...message, delivery: mergeDelivery(message.delivery, event.delivery) } : message) } });
    } else if (event.type === 'typing') {
      if (state.conversations.some((value) => value.id === event.conversationId && value.accountId === accountId)) this.publish({ ...state, typing: { ...state.typing, [event.conversationId]: event.names } });
    } else if (event.type === 'select-conversation') {
      if (state.conversations.some((value) => value.id === event.conversationId && value.accountId === accountId)) this.selectConversation(event.conversationId);
    } else if (event.type === 'error') {
      this.publish({ ...state,
        accounts: event.recoverable ? state.accounts : state.accounts.map((account) => account.id === accountId ? { ...account, status: 'error', error: event.message } : account),
        conversations: event.recoverable ? state.conversations : state.conversations.map(conversation => conversation.accountId === accountId ? { ...conversation, capabilities: { ...conversation.capabilities, sendMessages: false, typing: false, markRead: false } } : conversation),
        messages: event.recoverable ? state.messages : this.failPendingMessages(accountId, 'The account connection failed before delivery could be confirmed.'),
        typing: event.recoverable ? state.typing : Object.fromEntries(Object.entries(state.typing).filter(([id]) => !state.conversations.some(conversation => conversation.id === id && conversation.accountId === accountId))),
        notice: { id: crypto.randomUUID(), kind: 'error', message: event.message },
      });
    }
  }

  readonly sendMessage = async (conversationId: string, text: string): Promise<void> => {
    const body = text.trim();
    if (!body || body.length > 20_000) throw new Error('Messages must contain 1 to 20,000 characters.');
    const conversation = this.state.conversations.find((value) => value.id === conversationId);
    const connection = conversation && this.liveConnection(conversation.accountId);
    if (this.state.mode === 'live' && !connection) throw new Error('Account is not connected.');
    if (!conversation || !conversation.capabilities.sendMessages) throw new Error('Sending is unavailable for this conversation.');
    const operationId = crypto.randomUUID();
    const id = scopedId(conversation.accountId, operationId);
    const message = { id, accountId: conversation.accountId, conversationId, senderId: 'self', senderName: 'You', body, createdAt: new Date().toISOString(), direction: 'outgoing' as const, delivery: 'pending' as const };
    const existing = this.state.messages[conversationId] ?? [];
    this.publish({ ...this.state, messages: { ...this.state.messages, [conversationId]: [...existing, message] }, conversations: this.state.conversations.map((value) => value.id === conversationId ? { ...value, preview: `You: ${body}`, updatedAt: message.createdAt } : value) });
    if (this.state.mode === 'demo') {
      this.publish({ ...this.state, messages: { ...this.state.messages, [conversationId]: this.state.messages[conversationId]!.map((value) => value.id === id ? { ...value, delivery: 'accepted' } : value) } });
      return;
    }
    try {
      if (!connection) throw new Error('Account is not connected.');
      await connection.connector.sendMessage(conversation, body, operationId);
      if (this.liveConnection(conversation.accountId) !== connection) throw new Error('Account disconnected before delivery could be confirmed.');
      this.receive(conversation.accountId, { type: 'delivery', messageId: id, conversationId, delivery: 'accepted' });
    } catch (error) {
      const current = this.state.messages[conversationId]?.find((value) => value.id === id);
      if (current?.delivery === 'accepted' || current?.delivery === 'delivered' || current?.delivery === 'read') return;
      if (this.liveConnection(conversation.accountId) !== connection) throw new Error('Account disconnected before delivery could be confirmed.');
      this.publish({ ...this.state, messages: { ...this.state.messages, [conversationId]: (this.state.messages[conversationId] ?? []).map((value) => value.id === id ? { ...value, delivery: mergeDelivery(value.delivery, 'failed'), error: safeError(error) } : value) } });
      throw new Error(safeError(error));
    }
  };

  readonly setTyping = (conversationId: string) => {
    const conversation = this.state.conversations.find((value) => value.id === conversationId);
    if (this.state.mode !== 'live' || !conversation?.capabilities.typing || Date.now() - (this.typingSent.get(conversationId) ?? 0) < 4000) return;
    const connection = this.liveConnection(conversation.accountId);
    if (!connection) return;
    this.typingSent.set(conversationId, Date.now());
    void connection.connector.setTyping(conversation).catch(() => {});
  };

  readonly startConversation = async (accountId: string, address: string, name?: string): Promise<void> => {
    if (this.state.mode === 'demo') {
      const contact = this.state.contacts.find((value) => value.accountId === accountId && value.address === address);
      const existing = this.state.conversations.find((value) => value.accountId === accountId && (value.nativeId === contact?.nativeId || value.title === name));
      if (existing) this.selectConversation(existing.id);
      else this.notice('Choose one of the sample conversations to try the demo.');
      return;
    }
    const connection = this.liveConnection(accountId);
    if (!connection || !address.trim()) throw new Error('Choose a connected account and enter an address.');
    try { await connection.connector.startConversation(address.trim(), name); }
    catch (error) { const message = safeError(error); if (this.liveConnection(accountId) === connection) this.notice(message, 'error'); throw new Error(message); }
  };

  async close(): Promise<void> { await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnectAccount(id))); }
}
