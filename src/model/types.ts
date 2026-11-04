export type Provider = 'skype' | 'teamwire';
export type Theme = 'light' | 'dark' | 'system';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'demo';
export type Presence = 'online' | 'busy' | 'away' | 'offline' | 'unknown';

export interface Account {
  id: string;
  provider: Provider;
  label: string;
  address: string;
  server?: string;
  status: ConnectionStatus;
  error?: string;
}

export interface ConversationCapabilities {
  sendMessages: boolean;
  typing: boolean;
  markRead: boolean;
  attachments: boolean;
  audio: boolean;
  video: boolean;
  screenSharing: boolean;
}

export interface Conversation {
  id: string;
  accountId: string;
  provider: Provider;
  nativeId: string;
  title: string;
  initials: string;
  color: string;
  participants: string[];
  preview: string;
  updatedAt: string;
  unread: number;
  pinned: boolean;
  group: boolean;
  presence: Presence;
  capabilities: ConversationCapabilities;
}

export type MessageDelivery = 'pending' | 'accepted' | 'delivered' | 'read' | 'failed';
export interface Attachment {
  id: string;
  name: string;
  size?: string;
  kind: 'file' | 'image';
}

export interface Message {
  id: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
  direction: 'incoming' | 'outgoing';
  delivery: MessageDelivery;
  error?: string;
  attachments?: Attachment[];
}

export interface Contact {
  id: string;
  accountId: string;
  provider: Provider;
  nativeId: string;
  name: string;
  address: string;
  initials: string;
  color: string;
  presence: Presence;
}

/** Passwords exist only in the transient account form and connection attempt. */
export interface AccountInput {
  provider: Provider;
  label?: string;
  address: string;
  loginUsername?: string;
  password: string;
  server?: string;
  trustedOrigins?: string[];
}

export interface OriginApproval {
  id: string;
  accountId: string;
  accountLabel: string;
  origin: string;
}

export interface AppNotice { id: string; kind: 'info' | 'error' | 'success'; message: string }

export interface AppSnapshot {
  mode: 'demo' | 'live';
  accounts: Account[];
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  contacts: Contact[];
  selectedConversationId: string | null;
  theme: Theme;
  currentUser: { name: string; initials: string };
  typing: Record<string, string[]>;
  originApprovals: OriginApproval[];
  notice: AppNotice | null;
}

export interface AppShellProps {
  state: AppSnapshot;
  desktop: boolean;
  onSelectConversation(id: string): void;
  onSendMessage(conversationId: string, text: string): Promise<void>;
  onSetTyping(conversationId: string): void;
  onConnectAccount(input: AccountInput): Promise<void>;
  onDisconnectAccount(accountId: string): Promise<void>;
  onStartConversation(accountId: string, address: string, name?: string): Promise<void>;
  onChangeTheme(theme: Theme): void;
  onTogglePinned(conversationId: string): void;
  onEnterDemo(): void;
  onExitDemo(): void;
  onApproveOrigin(id: string, allow: boolean): void;
  onDismissNotice(): void;
}
