export type TeamwireFetch = typeof globalThis.fetch;
export type TeamwireRecord = Readonly<Record<string, unknown>>;

export interface TeamwireClientOptions {
  /** An explicit HTTPS origin, for example https://chat.example.org. */
  origin: string;
  fetch?: TeamwireFetch;
  crypto?: Crypto;
}

export interface TeamwireRequestOptions { signal?: AbortSignal }
export interface TeamwireSyncOptions extends TeamwireRequestOptions {
  /** ISO cursor; Teamwire transports this as a hex-encoded ETag. */
  since?: string;
}

export interface TeamwirePasswordLogin {
  email: string;
  password: string;
  registrationToken?: string;
  auditInfo?: Record<string, unknown>;
}

export interface TeamwireContact {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  raw: TeamwireRecord;
}

export interface TeamwireConversation {
  id: string;
  type: '1to1' | 'group' | 'unknown';
  title: string;
  participantIds: string[];
  groupIds: string[];
  roleIds: string[];
  updatedAt?: string;
  canSend: boolean;
  /** Conversation keys are deliberately omitted. */
  raw: TeamwireRecord;
}

export interface TeamwireMessage {
  id: string;
  threadId: string;
  senderId: string;
  text: string;
  /** ISO timestamp at millisecond precision. */
  timestamp: string;
  isSystem: boolean;
  decryption: 'decrypted' | 'empty' | 'failed' | 'missing-key' | 'unsupported';
  raw: TeamwireRecord;
}

export interface TeamwireSendReceipt {
  id: string;
  threadId: string;
  timestamp: string;
  clientMessageId: string;
  /** An HTTP response establishes acceptance, not recipient delivery. */
  delivery: 'accepted';
  raw: TeamwireRecord;
}

export interface TeamwireEvent {
  type: string;
  threadId?: string;
  raw: TeamwireRecord;
}

export interface TeamwireFeed {
  messages: TeamwireMessage[];
  events: TeamwireEvent[];
  readThreads: Array<{ threadId: string; timestamp: string }>;
  /** Preserve this opaque ISO cursor without rounding it. */
  cursor: string;
  raw: TeamwireRecord;
}

export interface TeamwireHistoryOptions extends TeamwireSyncOptions { days?: number }
export interface TeamwireSendOptions extends TeamwireRequestOptions {
  clientMessageId?: string;
  replyTo?: string;
}
export interface TeamwireWatchOptions extends TeamwireSyncOptions { intervalMs?: number }

export interface TeamwirePreferences {
  favouriteChatIds: string[];
  unreadChatIds: string[];
  mutedChatIds: string[];
  archivedChatIds: string[];
  raw: TeamwireRecord;
}
