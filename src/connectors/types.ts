import type { AccountInput, Contact, Conversation, Message, MessageDelivery } from '../model/types';

export type ConnectorEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'contact'; contact: Contact }
  | { type: 'message'; message: Message; historical?: boolean; replacesMessageId?: string }
  | { type: 'delivery'; messageId: string; conversationId: string; delivery: MessageDelivery }
  | { type: 'typing'; conversationId: string; names: string[] }
  | { type: 'select-conversation'; conversationId: string }
  | { type: 'error'; message: string };

export interface ConnectorContext {
  accountId: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  approveOrigin(origin: string): Promise<boolean>;
  emit(event: ConnectorEvent): void;
}

export interface AccountConnector {
  connect(input: AccountInput, context: ConnectorContext): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(conversation: Conversation, body: string, operationId: string): Promise<void>;
  startConversation(address: string, name?: string): Promise<void>;
  setTyping(conversation: Conversation): Promise<void>;
  loadConversation?(conversation: Conversation): Promise<void>;
  markRead?(conversation: Conversation): Promise<void>;
}

export const scopedId = (accountId: string, nativeId: string) => `${encodeURIComponent(accountId)}::${encodeURIComponent(nativeId)}`;
export function initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'; }
export function avatarColor(value: string): string {
  const colors = ['lavender', 'sage', 'peach', 'sky', 'rose', 'sand'];
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}
