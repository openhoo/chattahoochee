import { SkypeForHoo, passwordAuth, normalizeSipAddress, getLink, getLinks, hasLink, resourceReference, type ResourceReference, type UcwaEventBatch, type UcwaResource, type UcwaSession } from 'skypeforhoo';
import type { AccountInput, Contact, Conversation, Message } from '../model/types';
import { avatarColor, initials, scopedId, type AccountConnector, type ConnectorContext } from './types';
import { embeddedCollection, inlineMessage, plainText, ucwaDate, ucwaDelivery, ucwaPresence } from './skype-normalize';
import { safeError } from '../lib/native-transport';

const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;

export class SkypeConnector implements AccountConnector {
  private client?: SkypeForHoo;
  private session?: UcwaSession;
  private context?: ConnectorContext;
  private readonly lifetime = new AbortController();
  private polling?: Promise<void>;
  private pollFailure?: unknown;
  private readonly conversations = new Map<string, ResourceReference>();
  private readonly acceptedInvitations = new Set<string>();
  private readonly pendingMessages = new Map<string, string>();
  private readonly messageAliases = new Map<string, string>();
  private readonly earlyOutgoing = new Map<string, Pick<Message, 'createdAt' | 'delivery'>>();
  private readonly pendingInvitations = new Set<string>();
  private readonly participantNames = new Map<string, string>();
  private removeAbort?: () => void;

  async connect(input: AccountInput, context: ConnectorContext): Promise<void> {
    this.context = context;
    const abort = () => this.lifetime.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => context.signal.removeEventListener('abort', abort);
    if (context.signal.aborted) abort();
    this.client = new SkypeForHoo({
      sipAddress: input.address,
      auth: passwordAuth({ username: input.loginUsername || input.address, password: input.password }),
      fetch: context.fetch,
      ...(input.server ? { discoveryUrls: [new URL(input.server.includes('://') ? input.server : `https://${input.server}`).href] } : {}),
      trustedOrigins: input.trustedOrigins ?? [],
      trustOrigin: (origin) => context.approveOrigin(origin),
    });
    this.session = await this.client.connect({ userAgent: 'Chattahoochee/0.1.0', culture: navigatorLanguage() }, this.lifetime.signal);
    this.polling = this.consume().catch((error: unknown) => {
      this.pollFailure = error;
      if (!this.lifetime.signal.aborted) context.emit({ type: 'error', message: `Skype event connection stopped. ${safeError(error)} Disconnect and reconnect to resume.` });
    });
    await this.session.makeAvailable({ supportedModalities: ['Messaging'], signInAs: 'Online' }, this.lifetime.signal);
    if (this.pollFailure) throw this.pollFailure;
    await Promise.all([this.loadContacts(), this.loadConversations()]);
    if (this.pollFailure) throw this.pollFailure;
  }

  private requireSession(): UcwaSession {
    this.lifetime.signal.throwIfAborted();
    if (!this.session || !this.context) throw new Error('Skype is not connected.');
    return this.session;
  }

  private async collection(reference: ResourceReference, relation: string): Promise<ResourceReference[]> {
    const embedded = embeddedCollection(reference, relation);
    if (embedded.length > 0) return embedded;
    if (!hasLink(reference.data, relation)) return [];
    const results: ResourceReference[] = [];
    for (const url of getLinks(reference.data, relation, reference.url)) results.push(await this.requireSession().read(url, this.lifetime.signal));
    return results;
  }

  private async loadContacts(): Promise<void> {
    const session = this.requireSession();
    const people = await session.people(this.lifetime.signal);
    if (!hasLink(people.data, 'myContacts')) return;
    const contacts = await session.contacts(this.lifetime.signal);
    for (const contact of await this.collection(contacts, 'contact')) this.emitContact(contact);
  }

  private emitContact(reference: ResourceReference): void {
    const { data } = reference;
    const name = string(data.name, string(data.uri, 'Skype contact'));
    const presence = embeddedCollection(reference, 'contactPresence')[0]?.data;
    const contact: Contact = {
      id: scopedId(this.context!.accountId, reference.url), accountId: this.context!.accountId, provider: 'skype', nativeId: reference.url,
      name, address: string(data.uri), initials: initials(name), color: avatarColor(reference.url), presence: ucwaPresence(presence?.availability),
    };
    this.participantNames.set(reference.url, name);
    this.context!.emit({ type: 'contact', contact });
  }

  private async loadConversations(): Promise<void> {
    const session = this.requireSession();
    const communication = await session.communication(this.lifetime.signal);
    if (!hasLink(communication.data, 'conversations')) return;
    const conversations = await session.follow(communication, 'conversations', this.lifetime.signal);
    for (const conversation of await this.collection(conversations, 'conversation')) await this.emitConversation(conversation);
  }

  private async emitConversation(reference: ResourceReference): Promise<Conversation> {
    this.conversations.set(reference.url, reference);
    const participantResources = embeddedCollection(reference, 'participant');
    const participants = participantResources.filter((value) => value.data.local !== true).map((value) => string(value.data.name, string(value.data.uri))).filter(Boolean);
    const count = typeof reference.data.participantCount === 'number' ? reference.data.participantCount : participants.length + 1;
    const title = string(reference.data.subject) || participants.join(', ') || 'Skype conversation';
    let messaging = embeddedCollection(reference, 'messaging')[0];
    if (!messaging && hasLink(reference.data, 'messaging')) messaging = await this.requireSession().follow(reference, 'messaging', this.lifetime.signal);
    const conversation: Conversation = {
      id: scopedId(this.context!.accountId, reference.url), accountId: this.context!.accountId, provider: 'skype', nativeId: reference.url,
      title, initials: initials(title), color: avatarColor(reference.url), participants, preview: '', updatedAt: ucwaDate(reference.data.created),
      unread: 0, pinned: false, group: count > 2, presence: 'unknown',
      capabilities: { sendMessages: !!messaging && hasLink(messaging.data, 'sendMessage'), typing: !!messaging && hasLink(messaging.data, 'setIsTyping'), markRead: false, attachments: false, audio: false, video: false, screenSharing: false },
    };
    this.context!.emit({ type: 'conversation', conversation });
    return conversation;
  }

  private async ensureConversation(url: string): Promise<Conversation> {
    return this.emitConversation(this.conversations.get(url) ?? await this.requireSession().read(url, this.lifetime.signal));
  }

  private async consume(): Promise<void> {
    for await (const batch of this.requireSession().events({ signal: this.lifetime.signal })) await this.handleBatch(batch);
    if (!this.lifetime.signal.aborted) throw new Error('The Skype event stream ended.');
  }

  async handleBatch(batch: UcwaEventBatch): Promise<void> {
    const session = this.requireSession();
    for (const sender of batch.sender ?? []) for (const event of sender.events ?? []) {
      const relation = string(event.link?.rel);
      if (!event.link?.href || !relation) continue;
      const url = new URL(event.link.href, session.application.url).href;
      if (event.type === 'deleted') {
        if (relation === 'conversation') this.conversations.delete(url);
        continue;
      }
      if (!['conversation', 'message', 'messagingInvitation', 'typingParticipants', 'contact'].includes(relation)) continue;
      const embedded = event._embedded?.[relation];
      const reference = typeof embedded === 'object' && embedded !== null && !Array.isArray(embedded)
        ? resourceReference(embedded as UcwaResource, url)
        : await session.read(url, this.lifetime.signal);
      if (relation === 'conversation') await this.emitConversation(reference);
      else if (relation === 'contact') this.emitContact(reference);
      else if (relation === 'message') {
        let conversationUrl = sender.rel === 'conversation' && sender.href ? new URL(sender.href, session.application.url).href : undefined;
        if (!conversationUrl && hasLink(reference.data, 'messaging')) {
          const messaging = await session.follow(reference, 'messaging', this.lifetime.signal);
          if (hasLink(messaging.data, 'conversation')) conversationUrl = getLink(messaging.data, 'conversation', messaging.url);
        }
        if (conversationUrl) await this.emitMessage(reference, conversationUrl, event.status);
      } else if (relation === 'messagingInvitation') {
        if (reference.data.direction === 'Incoming' && hasLink(reference.data, 'accept') && !this.acceptedInvitations.has(reference.url)) {
          await session.invoke(reference, 'accept', { method: 'POST', signal: this.lifetime.signal });
          this.acceptedInvitations.add(reference.url);
        }
        const operationId = string(reference.data.operationId);
        const requested = this.pendingInvitations.has(operationId);
        const failed = reference.data.state === 'Failed' || event.status === 'Failed' || event.status === 'Failure';
        if (failed) {
          this.pendingInvitations.delete(operationId);
          this.context!.emit({ type: 'error', message: 'The Skype conversation invitation failed.' });
        }
        if (hasLink(reference.data, 'conversation')) {
          const conversation = await this.ensureConversation(getLink(reference.data, 'conversation', reference.url));
          if (requested && !failed && (reference.data.state === 'Connected' || event.status === 'Success')) {
            this.pendingInvitations.delete(operationId);
            this.context!.emit({ type: 'select-conversation', conversationId: conversation.id });
          }
        }
      } else if (relation === 'typingParticipants' && sender.rel === 'conversation' && sender.href) {
        const conversationId = scopedId(this.context!.accountId, new URL(sender.href, session.application.url).href);
        const names = (await this.collection(reference, 'participant')).map((value) => string(value.data.name, 'Someone'));
        this.context!.emit({ type: 'typing', conversationId, names });
      }
    }
  }

  private async content(reference: ResourceReference): Promise<string> {
    if (typeof reference.data.plainMessage === 'string') return reference.data.plainMessage;
    if (typeof reference.data.htmlMessage === 'string') return plainText(reference.data.htmlMessage, true);
    for (const relation of ['plainMessage', 'htmlMessage', 'message']) {
      if (!hasLink(reference.data, relation)) continue;
      const url = getLink(reference.data, relation, reference.url);
      if (url.startsWith('data:')) return inlineMessage(url).text;
      const result = await this.client!.transport.request<string>(url, { signal: this.lifetime.signal });
      if (typeof result.data === 'string') return plainText(result.data, relation === 'htmlMessage');
    }
    return '';
  }

  private async emitMessage(reference: ResourceReference, conversationUrl: string, eventStatus?: string): Promise<void> {
    const conversation = await this.ensureConversation(conversationUrl);
    const operationId = string(reference.data.operationId);
    const pendingId = this.messageAliases.get(reference.url) ?? this.pendingMessages.get(operationId);
    const outgoing = reference.data.direction === 'Outgoing';
    const status = eventStatus ?? reference.data.status;
    const delivery = outgoing ? ucwaDelivery(status === 'Success' ? 'Succeeded' : status === 'Failure' ? 'Failed' : status) : 'delivered';
    const createdAt = ucwaDate(reference.data.timeStamp);
    if (outgoing && !this.messageAliases.has(reference.url)) {
      this.earlyOutgoing.set(reference.url, { createdAt, delivery });
      if (this.earlyOutgoing.size > 512) this.earlyOutgoing.delete(this.earlyOutgoing.keys().next().value!);
    }
    let senderName = outgoing ? 'You' : 'Skype contact';
    if (!outgoing) {
      const participant = embeddedCollection(reference, 'participant')[0];
      if (participant) senderName = string(participant.data.name, senderName);
      else if (hasLink(reference.data, 'participant')) {
        const url = getLink(reference.data, 'participant', reference.url);
        if (!this.participantNames.has(url)) this.participantNames.set(url, string((await this.requireSession().read(url, this.lifetime.signal)).data.name, senderName));
        senderName = this.participantNames.get(url)!;
      }
    }
    const id = outgoing && pendingId ? pendingId : scopedId(this.context!.accountId, reference.url);
    const body = await this.content(reference);
    // Some outgoing completion events carry status only. Preserve the optimistic message body.
    if (outgoing && pendingId && body.length === 0) {
      this.context!.emit({ type: 'delivery', messageId: id, conversationId: conversation.id, delivery });
      return;
    }
    const message: Message = {
      id, accountId: this.context!.accountId, conversationId: conversation.id,
      senderId: outgoing ? 'self' : senderName, senderName, body,
      createdAt, direction: outgoing ? 'outgoing' : 'incoming', delivery,
    };
    this.context!.emit({ type: 'message', message });
  }

  async sendMessage(conversation: Conversation, body: string, operationId: string): Promise<void> {
    const reference = this.conversations.get(conversation.nativeId);
    if (!reference || conversation.accountId !== this.context?.accountId) throw new Error('This conversation does not belong to the connected Skype account.');
    const id = scopedId(this.context.accountId, operationId);
    this.pendingMessages.set(operationId, id);
    const result = await this.requireSession().sendMessage(reference, body, { operationId, signal: this.lifetime.signal });
    this.lifetime.signal.throwIfAborted();
    const location = result.response.headers.get('location');
    if (location) {
      const nativeUrl = new URL(location, result.url).href;
      this.messageAliases.set(nativeUrl, id);
      const early = this.earlyOutgoing.get(nativeUrl);
      if (early) {
        this.earlyOutgoing.delete(nativeUrl);
        this.context!.emit({ type: 'message', replacesMessageId: scopedId(this.context!.accountId, nativeUrl), message: {
          id, accountId: this.context!.accountId, conversationId: conversation.id, senderId: 'self', senderName: 'You',
          body, createdAt: early.createdAt, direction: 'outgoing', delivery: early.delivery,
        } });
      }
    }
  }

  async startConversation(address: string, _name?: string): Promise<void> {
    let target: string;
    try { target = `sip:${normalizeSipAddress(address)}`; }
    catch { throw new TypeError('Enter a complete SIP address.'); }
    const operationId = crypto.randomUUID();
    this.pendingInvitations.add(operationId);
    try { await this.requireSession().startMessaging({ to: target, operationId, signal: this.lifetime.signal }); }
    catch (error) { this.pendingInvitations.delete(operationId); throw error; }
  }

  async setTyping(conversation: Conversation): Promise<void> {
    const reference = this.conversations.get(conversation.nativeId);
    if (reference) await this.requireSession().setTyping(reference, this.lifetime.signal);
  }

  async disconnect(): Promise<void> {
    this.lifetime.abort();
    this.removeAbort?.();
    try { await this.session?.close(AbortSignal.timeout(5000)); }
    finally {
      await this.polling;
      this.session = undefined;
      this.client = undefined;
      this.context = undefined;
      this.pendingMessages.clear();
      this.messageAliases.clear();
      this.earlyOutgoing.clear();
      this.pendingInvitations.clear();
      this.acceptedInvitations.clear();
      this.participantNames.clear();
      this.conversations.clear();
    }
  }
}

function navigatorLanguage(): string { return typeof navigator !== 'undefined' ? navigator.language : 'en-US'; }
