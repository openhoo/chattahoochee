import type { Account, AppSnapshot, Conversation, ConversationCapabilities, Message, Theme } from './types';
import { avatarColor, initials } from '../connectors/types';

const capabilities: ConversationCapabilities = { sendMessages: true, typing: false, markRead: false, attachments: false, audio: false, video: false, screenSharing: false };

export function emptySnapshot(theme: Theme = 'light'): AppSnapshot {
  return { mode: 'live', accounts: [], conversations: [], contacts: [], messages: {}, selectedConversationId: null, theme, currentUser: { name: 'Your workspace', initials: 'CH' }, typing: {}, originApprovals: [], notice: null };
}

/** Explicitly synthetic workspace. These identifiers are never used by live connectors. */
export function demoSnapshot(theme: Theme = 'light'): AppSnapshot {
  const now = new Date();
  now.setHours(10, 42, 0, 0);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const accounts: Account[] = [
    { id: 'demo:skype', provider: 'skype', label: 'Skype for Business', address: 'you@example.com', status: 'demo' },
    { id: 'demo:teamwire', provider: 'teamwire', label: 'Teamwire', address: 'you@example.com', status: 'demo', server: 'https://teamwire.example.com' },
  ];
  const definitions = [
    { id: 'demo:maya', provider: 'teamwire' as const, title: 'Maya Chen', preview: 'The little details make all the difference ✨', minutes: 0, unread: 2, pinned: true, group: false, presence: 'online' as const, participants: ['Maya Chen', 'You'], color: 'lavender' },
    { id: 'demo:design', provider: 'teamwire' as const, title: 'Design studio', preview: 'Noah: Just added the updated explorations', minutes: 12, unread: 3, pinned: true, group: true, presence: 'unknown' as const, participants: ['Maya Chen', 'Noah Williams', 'Alex Morgan', 'You'], color: 'peach' },
    { id: 'demo:oliver', provider: 'skype' as const, title: 'Oliver Park', preview: 'You: Sounds good. See you there!', minutes: 38, unread: 0, pinned: true, group: false, presence: 'busy' as const, participants: ['Oliver Park', 'You'], color: 'sage' },
    { id: 'demo:launch', provider: 'skype' as const, title: 'Launch crew', preview: 'Everything is ready for tomorrow 🚀', minutes: 66, unread: 0, pinned: false, group: true, presence: 'unknown' as const, participants: ['Oliver Park', 'Sofia Rivera', 'You'], color: 'sky' },
    { id: 'demo:sofia', provider: 'teamwire' as const, title: 'Sofia Rivera', preview: 'Thanks for the thoughtful feedback!', minutes: 125, unread: 0, pinned: false, group: false, presence: 'away' as const, participants: ['Sofia Rivera', 'You'], color: 'rose' },
    { id: 'demo:noah', provider: 'skype' as const, title: 'Noah Williams', preview: 'I’ll take a look after lunch.', minutes: 1420, unread: 0, pinned: false, group: false, presence: 'offline' as const, participants: ['Noah Williams', 'You'], color: 'sand' },
  ];
  const conversations: Conversation[] = definitions.map((definition) => ({
    ...definition, nativeId: definition.id, accountId: `demo:${definition.provider}`, initials: initials(definition.title), updatedAt: ago(definition.minutes), capabilities: { ...capabilities },
  }));
  const message = (conversationId: string, index: number, body: string, outgoing: boolean, minutes: number, extra: Partial<Message> = {}): Message => {
    const conversation = conversations.find((value) => value.id === conversationId)!;
    return { id: `${conversationId}:message:${index}`, accountId: conversation.accountId, conversationId,
      senderId: outgoing ? 'self' : conversation.title, senderName: outgoing ? 'You' : conversation.title,
      body, direction: outgoing ? 'outgoing' : 'incoming', createdAt: ago(minutes), delivery: outgoing ? 'read' : 'delivered', ...extra };
  };
  const messages: Record<string, Message[]> = {
    'demo:maya': [
      message('demo:maya', 1, 'Morning! I’ve been working on a few ideas for the new workspace. Have a moment to take a look?', false, 81),
      message('demo:maya', 2, 'Of course! Send them over. I’m just wrapping up my coffee ☕', true, 78),
      message('demo:maya', 3, 'I wanted it to feel a little calmer. More room for the conversations, fewer things competing for attention.', false, 74),
      message('demo:maya', 4, 'Here’s the latest direction. The notes are on page two.', false, 73, { attachments: [{ id: 'demo:brief', name: 'Workspace explorations.pdf', size: '2.4 MB · Demo file', kind: 'file' }] }),
      message('demo:maya', 5, 'This feels really good. The softer palette makes such a difference.\n\nLet’s bring the team into this direction.', true, 68),
      message('demo:maya', 6, 'Exactly what I was hoping for. I’ll put together the next iteration this afternoon.', false, 4),
      message('demo:maya', 7, 'The little details make all the difference ✨', false, 0),
    ],
    'demo:design': [
      message('demo:design', 1, 'A small place for big ideas. Welcome to the studio.', false, 240, { senderName: 'Maya Chen' }),
      message('demo:design', 2, 'Love it. I’m adding our typography and spacing notes here.', true, 215),
      message('demo:design', 3, 'Just added the updated explorations. Looking forward to your thoughts!', false, 12, { senderName: 'Noah Williams' }),
    ],
    'demo:oliver': [message('demo:oliver', 1, 'Quick catch-up at 14:00? I have a couple of notes on the handoff.', false, 45), message('demo:oliver', 2, 'Sounds good. See you there!', true, 38)],
    'demo:launch': [message('demo:launch', 1, 'The final review is complete. Thank you for making this feel effortless.', false, 98, { senderName: 'Sofia Rivera' }), message('demo:launch', 2, 'Everything is ready for tomorrow 🚀', false, 66, { senderName: 'Oliver Park' })],
    'demo:sofia': [message('demo:sofia', 1, 'Thanks for the thoughtful feedback!', false, 125)],
    'demo:noah': [message('demo:noah', 1, 'I’ll take a look after lunch.', false, 1420)],
  };
  return {
    ...emptySnapshot(theme), mode: 'demo', accounts, conversations, messages, selectedConversationId: 'demo:maya',
    currentUser: { name: 'Alex Morgan', initials: 'AM' },
    contacts: definitions.filter((value) => !value.group).map((value) => ({
      id: `demo:contact:${value.id}`, accountId: `demo:${value.provider}`, provider: value.provider, nativeId: value.id,
      name: value.title, address: `${value.title.toLowerCase().replace(' ', '.')}@example.com`, initials: initials(value.title), color: avatarColor(value.id), presence: value.presence,
    })),
  };
}
