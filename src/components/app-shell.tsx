import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type MouseEvent, type ReactNode, type SetStateAction } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, Ellipsis, FlaskConical, Hash, Inbox, Info, LoaderCircle, LockKeyhole, MessageCircle, MessagesSquare, Moon, PanelRightClose, Paperclip, Phone, Plus, ScreenShare, Search, Send, Settings2, ShieldCheck, Smile, Sparkles, Star, Sun, Users, Video, WifiOff, X } from 'lucide-react';
import type { Account, AppShellProps, Conversation, Message as ChatMessage, Provider } from '@/model/types';
import { cn } from '@/lib/utils';
import { Popover } from 'radix-ui';
import { Button } from './ui/button';
import { Bubble, BubbleContent } from './ui/bubble';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Marker, MarkerContent } from './ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from './ui/message';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from './ui/message-scroller';
import { AccountDialog } from './account-dialog';
import { NewConversationDialog } from './new-conversation-dialog';
import { AttachmentTile, Avatar, ConnectionDot, Delivery, IconButton, ProviderIcon, dayLabel, inboxDateLabel, initialsFor, providerName, timeLabel } from './chat-parts';

type View = 'inbox' | 'pinned' | 'contacts';

export function AppShell(props: AppShellProps) {
  const { state, desktop } = props;
  const [view, setView] = useState<View>('inbox');
  const [providerFilter, setProviderFilter] = useState<'all' | Provider>('all');
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1100);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'accounts' | 'appearance'>('accounts');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileList, setMobileList] = useState(false);
  const [contactError, setContactError] = useState('');
  const [startingContact, setStartingContact] = useState<string | null>(null);
  const [detailsNarrow, setDetailsNarrow] = useState(() => window.matchMedia('(max-width: 1099px)').matches);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const newChatReturnFocus = useRef<HTMLElement | null>(null);
  const aboutReturnFocus = useRef<HTMLElement | null>(null);
  const detailsReturnFocus = useRef<HTMLElement | null>(null);
  const conversation = state.conversations.find((item) => item.id === state.selectedConversationId);
  const account = state.accounts.find((item) => item.id === conversation?.accountId);
  const messages = conversation ? state.messages[conversation.id] ?? [] : [];
  const draftKey = `${state.mode}:${conversation?.id ?? ''}`;
  const unreadCount = state.conversations.reduce((count, item) => count + item.unread, 0);
  const connected = state.accounts.filter((item) => item.status === 'connected').length;
  const approval = state.originApprovals[0];
  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const isDark = state.theme === 'dark' || (state.theme === 'system' && systemDark);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1099px)');
    const update = () => { setDetailsNarrow(narrow.matches); if (narrow.matches) setDetailsOpen(false); };
    narrow.addEventListener('change', update);
    return () => narrow.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (settingsOpen || newChatOpen || aboutOpen || approval || (detailsNarrow && detailsOpen)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setMobileList(true); requestAnimationFrame(() => searchRef.current?.focus()); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); openNewChat(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, newChatOpen, aboutOpen, approval, detailsNarrow, detailsOpen]);

  const conversations = useMemo(() => state.conversations.filter((item) =>
    (providerFilter === 'all' || item.provider === providerFilter) &&
    (view !== 'pinned' || item.pinned) &&
    (!unreadOnly || item.unread > 0) &&
    `${item.title} ${item.preview}`.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)), [state.conversations, providerFilter, view, unreadOnly, query]);
  const contacts = state.contacts.filter((item) => (providerFilter === 'all' || item.provider === providerFilter) && `${item.name} ${item.address}`.toLowerCase().includes(query.trim().toLowerCase()));

  function openAccounts(event?: MouseEvent<HTMLElement>, section: 'accounts' | 'appearance' = 'accounts') {
    settingsReturnFocus.current = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSettingsSection(section); setSettingsOpen(true);
  }
  function restoreSettingsFocus(event: Event) {
    event.preventDefault();
    focusWorkspace(settingsReturnFocus.current);
  }
  function rememberOpener(target: { current: HTMLElement | null }, event?: MouseEvent<HTMLElement>) {
    target.current = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }
  function focusWorkspace(preferred: HTMLElement | null) {
    const candidates = [preferred, searchRef.current, document.querySelector<HTMLElement>('#message-composer'), document.querySelector<HTMLElement>('.details-toggle'), document.querySelector<HTMLElement>('.rail-bottom button[aria-label="Workspace settings"]')];
    candidates.find((target) => target?.isConnected && target.getClientRects().length > 0 && !target.matches(':disabled'))?.focus({ preventScroll: true });
  }
  function restoreOpener(event: Event, target: { current: HTMLElement | null }) { event.preventDefault(); focusWorkspace(target.current); }
  function openAccountsFromDetails() { openAccounts(); settingsReturnFocus.current = detailsReturnFocus.current ?? document.querySelector<HTMLElement>('.details-toggle'); setDetailsOpen(false); }
  function openNewChat(event?: MouseEvent<HTMLElement>) { rememberOpener(newChatReturnFocus, event); setNewChatOpen(true); }
  function closeDetails() { setDetailsOpen(false); if (!detailsNarrow) requestAnimationFrame(() => (detailsReturnFocus.current?.isConnected ? detailsReturnFocus.current : document.querySelector<HTMLButtonElement>('.details-toggle'))?.focus({ preventScroll: true })); }
  function clearFilters() { setQuery(''); setProviderFilter('all'); setUnreadOnly(false); searchRef.current?.focus(); }
  async function startConversation(accountId: string, address: string, name?: string) {
    await props.onStartConversation(accountId, address, name);
    setView('inbox'); setMobileList(false);
  }
  async function startContact(contact: AppShellProps['state']['contacts'][number]) {
    if (startingContact) return;
    setContactError(''); setStartingContact(contact.id);
    try { await startConversation(contact.accountId, contact.address, contact.name); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#message-composer')?.focus()); }
    catch (error) { setContactError(error instanceof Error ? error.message : 'Unable to open this conversation.'); }
    finally { setStartingContact(null); }
  }
  const hasFilters = Boolean(query.trim() || providerFilter !== 'all' || unreadOnly);
  const emptyTitle = query.trim() ? 'No matches just yet' : unreadOnly ? 'You’re all caught up' : view === 'pinned' ? 'Keep good conversations close' : hasFilters ? `No ${providerFilter === 'all' ? '' : providerName(providerFilter) + ' '}${view === 'contacts' ? 'contacts' : 'conversations'} yet` : state.accounts.length ? view === 'contacts' ? 'No contacts yet' : 'No conversations yet' : 'A fresh start';
  const emptyDescription = query.trim() ? `No ${view === 'contacts' ? 'people' : 'conversations'} match “${query.trim()}”. Try another name or clear your filters.` : unreadOnly ? 'There are no unread conversations in this view. Clear your filters to see the rest.' : view === 'pinned' ? 'Pin a conversation from its details to find it here.' : state.accounts.length ? view === 'contacts' ? 'Contacts from your connected accounts will appear here.' : 'Start a conversation or choose another provider.' : 'Connect an account and your conversations will appear here.';
  function selectConversation(id: string) {
    props.onSelectConversation(id); setMobileList(false);
    if (window.matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => focusWorkspace(document.querySelector<HTMLElement>('#message-composer')));
  }
  function showConversationList() { setMobileList(true); requestAnimationFrame(() => searchRef.current?.focus()); }
  function chooseView(next: View) { setView(next); setQuery(''); setUnreadOnly(false); setContactError(''); setMobileList(true); }

  return <div className={cn('messenger-app', desktop && 'is-desktop', conversation && 'has-conversation', mobileList && 'show-mobile-list', detailsOpen && 'details-open')}>
    <aside className="app-rail" aria-label="Workspace navigation">
      <button type="button" className="app-logo" aria-label="Chattahoochee home" title="Chattahoochee" onClick={() => chooseView('inbox')}><ChattahoocheeMark /></button>
      <div className="rail-separator" />
      <nav className="rail-navigation"><RailButton label="Inbox" active={view === 'inbox'} onClick={() => chooseView('inbox')} count={unreadCount}><Inbox /></RailButton><RailButton label="Pinned conversations" active={view === 'pinned'} onClick={() => chooseView('pinned')}><Star /></RailButton><RailButton label="People" active={view === 'contacts'} onClick={() => chooseView('contacts')}><Users /></RailButton></nav>
      <div className="rail-bottom"><RailButton label="About Chattahoochee" onClick={(event) => { rememberOpener(aboutReturnFocus, event); setAboutOpen(true); }}><CircleHelp /></RailButton><RailButton label={isDark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => props.onChangeTheme(isDark ? 'light' : 'dark')}>{isDark ? <Sun /> : <Moon />}</RailButton><RailButton label="Workspace settings" onClick={openAccounts}><Settings2 /></RailButton><div className="rail-separator" /><button type="button" className="current-user" aria-label={`${state.currentUser.name}, manage accounts`} title={state.currentUser.name} onClick={openAccounts}>{state.currentUser.initials}</button></div>
    </aside>

    <div className="workspace-frame">
      <header className={cn('workspace-topbar', state.mode === 'demo' && 'demo-topbar')} data-tauri-drag-region>
        <div className="workspace-label" data-tauri-drag-region>{state.mode === 'demo' ? <><FlaskConical aria-hidden="true" /><strong>Demo workspace</strong><span className="topbar-divider" /><span>Sample conversations. No real messages.</span></> : <><span className="workspace-monogram">C</span><strong>Your workspace</strong></>}</div>
        <div className="workspace-status">{state.mode === 'demo' ? <button type="button" onClick={props.onExitDemo}>Leave demo<ArrowRight /></button> : <><span className={cn('topbar-status-dot', connected > 0 && 'is-connected')} /><span>{connected ? `${connected} account${connected === 1 ? '' : 's'} connected` : 'Ready when you are'}</span><button type="button" onClick={openAccounts}>Manage accounts</button></>}</div>
      </header>

      <div className="workspace-columns">
        <section className="inbox-panel" aria-label={view === 'contacts' ? 'Contacts' : 'Conversations'}>
          <div className="inbox-heading"><div><span className="eyebrow">A LITTLE LESS SWITCHING</span><h1>{view === 'contacts' ? 'People' : view === 'pinned' ? 'Pinned' : 'Inbox'}<span className="heading-dot">.</span></h1></div><IconButton label="New conversation" className="new-conversation-button" onClick={openNewChat}><Plus /></IconButton></div>
          <div className="inbox-search"><Search aria-hidden="true" /><input ref={searchRef} aria-label={view === 'contacts' ? 'Search people' : 'Search conversations'} placeholder={view === 'contacts' ? 'Find someone…' : 'Search conversations…'} value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X /></button> : <kbd>{shortcutModifier} K</kbd>}</div>
          <div className="provider-filters" role="group" aria-label="Filter by messaging provider"><button type="button" className={cn(providerFilter === 'all' && 'is-active')} aria-pressed={providerFilter === 'all'} onClick={() => setProviderFilter('all')}>All<span>{view === 'contacts' ? state.contacts.length : view === 'pinned' ? state.conversations.filter((item) => item.pinned).length : state.conversations.length}</span></button><button type="button" className={cn(providerFilter === 'skype' && 'is-active')} aria-pressed={providerFilter === 'skype'} onClick={() => setProviderFilter('skype')}><ProviderIcon provider="skype" />Skype</button><button type="button" className={cn(providerFilter === 'teamwire' && 'is-active')} aria-pressed={providerFilter === 'teamwire'} onClick={() => setProviderFilter('teamwire')}><ProviderIcon provider="teamwire" />Teamwire</button></div>
          <div className="list-section-heading"><span>{view === 'contacts' ? 'YOUR PEOPLE' : view === 'pinned' ? 'PINNED' : 'MESSAGES'} <span className="list-count" role="status" aria-live="polite" aria-label={`${view === 'contacts' ? contacts.length : conversations.length} ${view === 'contacts' ? 'people' : 'conversations'} shown`}>{view === 'contacts' ? contacts.length : conversations.length}</span></span>{view !== 'contacts' && <button type="button" className={cn(unreadOnly && 'is-active')} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}><span className="unread-filter-dot" />Unread</button>}</div>
          <div className="conversation-list" aria-label={view === 'contacts' ? 'Contact list' : 'Conversation list'}>
            {view === 'contacts' ? contacts.map((contact) => <button key={contact.id} type="button" className="conversation-row contact-row" disabled={Boolean(startingContact)} aria-busy={startingContact === contact.id} onClick={() => void startContact(contact)}><Avatar initials={contact.initials} color={contact.color} presence={contact.presence} /><span className="conversation-row-content"><span className="conversation-title">{contact.name}</span><span className="conversation-preview">{contact.address}</span><span className="conversation-provider"><ProviderIcon provider={contact.provider} />{providerName(contact.provider)}</span></span>{startingContact === contact.id ? <LoaderCircle className="contact-arrow spin" /> : <ChevronRight className="contact-arrow" />}</button>) : conversations.map((item) => <ConversationRow key={item.id} conversation={item} draft={drafts[`${state.mode}:${item.id}`]} selected={item.id === state.selectedConversationId} onClick={() => selectConversation(item.id)} />)}
            {!(view === 'contacts' ? contacts.length : conversations.length) && <div className="list-empty"><span className="list-empty-icon">{query.trim() ? <Search /> : unreadOnly ? <Check /> : view === 'pinned' ? <Star /> : <MessagesSquare />}</span><h3>{emptyTitle}</h3><p>{emptyDescription}</p>{hasFilters ? <button type="button" onClick={clearFilters}>Clear filters<ArrowRight /></button> : view !== 'pinned' && <button type="button" onClick={state.accounts.length ? openNewChat : openAccounts}>{state.accounts.length ? 'Start a conversation' : 'Connect an account'}<ArrowRight /></button>}</div>}
            {contactError && <p className="form-error" role="alert">{contactError}</p>}
          </div>
          <div className="inbox-footer"><div className="account-icons">{state.accounts.length ? state.accounts.slice(0, 3).map((item) => <button type="button" key={item.id} title={`${item.label}: ${item.status === 'demo' ? 'Demo account' : item.status}`} aria-label={`Manage ${item.label}`} onClick={openAccounts}><ProviderIcon provider={item.provider} /><ConnectionDot status={item.status} /></button>) : <><ProviderIcon provider="skype" /><ProviderIcon provider="teamwire" /></>}</div><div><strong>{state.mode === 'demo' ? 'Just a little preview' : state.accounts.length ? 'Together, in one place' : 'Make room for connection'}</strong><span>{state.mode === 'demo' ? 'Your real accounts are one step away.' : `${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'} in this workspace`}</span></div><button type="button" className="footer-add" aria-label="Manage accounts" onClick={openAccounts}><Plus /></button></div>
        </section>

        <main className="conversation-panel" aria-label={conversation ? `Conversation with ${conversation.title}` : 'Welcome to Chattahoochee'}>
          {conversation ? <>
            <header className="conversation-heading"><IconButton label="Back to conversations" className="mobile-back" onClick={showConversationList}><ArrowLeft /></IconButton><Avatar initials={conversation.initials} color={conversation.color} presence={conversation.group ? undefined : conversation.presence} group={conversation.group} /><div className="conversation-heading-title"><h2 title={conversation.title}>{conversation.title}{conversation.group && <span className="group-count">{conversation.participants.length}</span>}</h2><div><ProviderIcon provider={conversation.provider} /><span>{providerName(conversation.provider)}</span><span className="text-dot">·</span><span>{conversation.group ? `${conversation.participants.length} people` : state.mode === 'demo' ? 'Demo conversation' : conversation.presence === 'online' ? 'Available' : conversation.presence === 'unknown' ? 'Work conversation' : conversation.presence.charAt(0).toUpperCase() + conversation.presence.slice(1)}</span></div></div><div className="conversation-actions"><UnavailableAction label="Audio calling is not available in this preview"><Phone /></UnavailableAction><UnavailableAction label="Video calling is not available in this preview"><Video /></UnavailableAction><UnavailableAction label="Screen sharing is not available in this preview"><ScreenShare /></UnavailableAction><span className="toolbar-divider" /><IconButton label={detailsOpen ? 'Hide conversation details' : 'Show conversation details'} className={cn('details-toggle', detailsOpen && 'is-active')} aria-pressed={detailsOpen} onClick={(event) => { rememberOpener(detailsReturnFocus, event); setDetailsOpen(!detailsOpen); }}><Info /></IconButton></div></header>
            {account && account.status !== 'connected' && account.status !== 'demo' && <ConnectionBanner account={account} onOpenAccounts={openAccounts} />}
            <Transcript key={`transcript:${state.mode}:${conversation.id}`} conversation={conversation} messages={messages} demo={state.mode === 'demo'} currentUser={state.currentUser.name} />
            <div className="typing-indicator" aria-live="polite">{(state.typing[conversation.id] ?? []).length > 0 && <><span className="typing-dots"><i /><i /><i /></span>{state.typing[conversation.id]!.join(', ')} is typing…</>}</div>
            <Composer key={`composer:${draftKey}`} conversation={conversation} account={account} demo={state.mode === 'demo'} draft={drafts[draftKey] ?? ''} setDraft={(value) => setDrafts((current) => ({ ...current, [draftKey]: typeof value === 'function' ? value(current[draftKey] ?? '') : value }))} onSend={props.onSendMessage} onTyping={props.onSetTyping} onOpenAccounts={openAccounts} />
          </> : <Welcome demo={state.mode === 'demo'} onOpenAccounts={openAccounts} onEnterDemo={props.onEnterDemo} onNewChat={openNewChat} hasAccounts={state.accounts.length > 0} />}
        </main>

        {conversation && detailsOpen && (detailsNarrow ? <Dialog open onOpenChange={(open) => { if (!open) setDetailsOpen(false); }}><DialogContent className="details-drawer translate-x-0 translate-y-0" showCloseButton={false} onCloseAutoFocus={(event) => restoreOpener(event, detailsReturnFocus)}><DialogTitle className="sr-only">Conversation information</DialogTitle><DialogDescription className="sr-only">Account, people and files for {conversation.title}.</DialogDescription><ConversationDetails key={conversation.id} conversation={conversation} account={account} messages={messages} demo={state.mode === 'demo'} onClose={closeDetails} onTogglePinned={() => props.onTogglePinned(conversation.id)} onOpenAccounts={openAccountsFromDetails} /></DialogContent></Dialog> : <ConversationDetails key={conversation.id} conversation={conversation} account={account} messages={messages} demo={state.mode === 'demo'} onClose={closeDetails} onTogglePinned={() => props.onTogglePinned(conversation.id)} onOpenAccounts={openAccounts} />)}
      </div>
    </div>

    {state.notice && <div className={cn('app-notice', `notice-${state.notice.kind}`)} role={state.notice.kind === 'error' ? 'alert' : 'status'}>{state.notice.kind === 'success' ? <Check /> : <Info />}<span>{state.notice.message}</span><IconButton label="Dismiss notification" onClick={props.onDismissNotice}><X /></IconButton></div>}
    <AccountDialog state={state} desktop={desktop} open={settingsOpen} initialSection={settingsSection} onOpenChange={setSettingsOpen} onCloseAutoFocus={restoreSettingsFocus} onConnectAccount={props.onConnectAccount} onDisconnectAccount={props.onDisconnectAccount} onChangeTheme={props.onChangeTheme} onEnterDemo={props.onEnterDemo} onExitDemo={props.onExitDemo} />
    <NewConversationDialog state={state} open={newChatOpen} onOpenChange={setNewChatOpen} onCloseAutoFocus={(event) => restoreOpener(event, newChatReturnFocus)} onStartConversation={startConversation} onOpenAccounts={() => { openAccounts(); settingsReturnFocus.current = newChatReturnFocus.current; }} />
    <Dialog open={aboutOpen} onOpenChange={setAboutOpen}><DialogContent className="about-dialog" onCloseAutoFocus={(event) => restoreOpener(event, aboutReturnFocus)}><DialogHeader><span className="about-mark"><ChattahoocheeMark /></span><DialogTitle>Good conversations.<br />A little closer together.</DialogTitle><DialogDescription>Chattahoochee brings Skype for Business and Teamwire into one calm workspace.</DialogDescription></DialogHeader><div className="about-provider-row"><ProviderIcon provider="skype" /><span>+</span><ProviderIcon provider="teamwire" /></div><div className="about-capabilities"><section><h3>Text conversations, together</h3><p>Connect your accounts to find people and exchange messages. Available features depend on your organization’s service.</p></section><section><h3>A preview with room to grow</h3><p>Audio calls, video calls, screen sharing, and file transfers are not available yet. Demo messages stay in this app.</p></section></div><div className="about-shortcuts"><h3>Keyboard shortcuts</h3><p><span>Search conversations</span><kbd>{shortcutModifier} K</kbd></p><p><span>New conversation</span><kbd>{shortcutModifier} N</kbd></p><p><span>Send a message</span><kbd>Enter</kbd></p><p><span>New line</span><kbd>Shift Enter</kbd></p></div><p className="about-version">Chattahoochee · 0.1.0 preview</p></DialogContent></Dialog>
    <Dialog open={Boolean(approval)} onOpenChange={(open) => { if (!open && approval) props.onApproveOrigin(approval.id, false); }}><DialogContent className="origin-dialog" showCloseButton={false}><DialogHeader><span className="origin-shield"><ShieldCheck /></span><DialogTitle>Allow this sign-in service?</DialogTitle><DialogDescription>{approval?.accountLabel} needs to connect to this service to continue signing in.</DialogDescription></DialogHeader><code className="origin-address">{approval?.origin}</code><p className="origin-help">This HTTPS service will receive sign-in or messaging requests for this connection. Allow it only if you recognize the address as part of your organization’s messaging service.</p><div className="form-actions"><Button variant="outline" onClick={() => approval && props.onApproveOrigin(approval.id, false)}>Cancel connection</Button><Button onClick={() => approval && props.onApproveOrigin(approval.id, true)}>Allow service<ArrowRight /></Button></div></DialogContent></Dialog>
  </div>;
}

function ChattahoocheeMark() { return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M30 10a14 14 0 1 0 0 20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /><path d="M13 18c4-5 8 5 14 0M13 25c4-5 8 5 14 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>; }

function UnavailableAction({ label, children }: { label: string; children: ReactNode }) { return <span className="unavailable-action" title={label}><IconButton label={label} disabled>{children}</IconButton></span>; }

function RailButton({ children, label, active, count, onClick }: { children: ReactNode; label: string; active?: boolean; count?: number; onClick(event: MouseEvent<HTMLButtonElement>): void }) {
  return <button type="button" className={cn('rail-button', active && 'is-active')} title={label} aria-label={count ? `${label}, ${count} unread messages` : label} aria-current={active ? 'page' : undefined} onClick={onClick}>{children}{active !== undefined && <span className="rail-label" aria-hidden="true">{label === 'Pinned conversations' ? 'Pinned' : label}</span>}{count ? <span className="rail-unread" aria-hidden="true">{count > 9 ? '9+' : count}</span> : null}{active && <span className="rail-active-mark" />}</button>;
}

function ConversationRow({ conversation, draft, selected, onClick }: { conversation: Conversation; draft?: string; selected: boolean; onClick(): void }) {
  return <button type="button" className={cn('conversation-row', selected && 'is-selected', conversation.unread > 0 && 'has-unread')} aria-current={selected ? 'page' : undefined} onClick={onClick}><Avatar initials={conversation.initials} color={conversation.color} group={conversation.group} presence={conversation.group ? undefined : conversation.presence} /><span className="conversation-row-content"><span className="conversation-row-top"><span className="conversation-title" title={conversation.title}>{conversation.group && <Hash aria-hidden="true" />}{conversation.title}</span><time dateTime={conversation.updatedAt} title={new Date(conversation.updatedAt).toLocaleString()}>{inboxDateLabel(conversation.updatedAt)}</time></span><span className={cn('conversation-preview', draft?.trim() && 'has-draft')}>{draft?.trim() ? <><strong>Draft</strong><span aria-hidden="true"> · </span>{draft}</> : conversation.preview || 'Start a conversation'}</span><span className="conversation-row-bottom"><span className="conversation-provider"><ProviderIcon provider={conversation.provider} />{providerName(conversation.provider)}</span><span className="conversation-markers">{conversation.pinned && <Star className="pinned-icon" aria-label="Pinned" />}{conversation.unread > 0 && <span className="unread-badge" aria-label={`${conversation.unread} unread messages`}>{conversation.unread}</span>}</span></span></span></button>;
}

function Transcript({ conversation, messages, demo, currentUser }: { conversation: Conversation; messages: ChatMessage[]; demo: boolean; currentUser: string }) {
  return <div className="transcript-region"><MessageScrollerProvider><MessageScroller><MessageScrollerViewport className="transcript-viewport"><MessageScrollerContent className="transcript-content" aria-label="Messages" aria-live="polite" aria-relevant="additions">
    <MessageScrollerItem messageId={`${conversation.id}:beginning`}><div className="conversation-beginning"><span><MessageCircle aria-hidden="true" /></span><p>{demo ? 'Sample messages · Demo only' : 'Messages from this session'}</p></div></MessageScrollerItem>
    {messages.map((message, index) => {
      const previous = messages[index - 1];
      const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
      const outgoing = message.direction === 'outgoing';
      return <MessageScrollerItem key={message.id} messageId={message.id} className="transcript-row" scrollAnchor={outgoing}>
        {newDay && <Marker variant="separator" className="transcript-day"><MarkerContent>{dayLabel(message.createdAt)}</MarkerContent></Marker>}
        <Message align={outgoing ? 'end' : 'start'} className={cn('chat-message', outgoing && 'outgoing-message')}>
          {!outgoing && <Avatar initials={initialsFor(message.senderName)} color={conversation.color} className="message-person" />}
          <MessageContent className="chat-message-content"><MessageHeader className="chat-message-header"><strong>{outgoing ? currentUser.split(' ')[0] || 'You' : message.senderName}</strong><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time></MessageHeader><Bubble variant={outgoing ? 'default' : 'secondary'} align={outgoing ? 'end' : 'start'} className="chat-bubble"><BubbleContent className="chat-bubble-content">{message.body && <p>{message.body}</p>}{message.attachments?.map((attachment) => <AttachmentTile key={attachment.id} attachment={attachment} />)}</BubbleContent></Bubble>{outgoing && <MessageFooter className="chat-message-footer"><Delivery status={message.delivery} error={message.error} demo={demo} /></MessageFooter>}</MessageContent>
        </Message>
      </MessageScrollerItem>;
    })}
    {!messages.length && <MessageScrollerItem messageId={`${conversation.id}:empty`}><div className="transcript-empty"><span><MessageCircle /></span><h3>A good place to say hello.</h3><p>Start your conversation with {conversation.title}.</p></div></MessageScrollerItem>}
  </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton className="jump-to-latest" aria-label="Jump to latest message"><ArrowDown /><span>Latest messages</span></MessageScrollerButton></MessageScroller></MessageScrollerProvider></div>;
}

function Composer({ conversation, account, demo, draft, setDraft, onSend, onTyping, onOpenAccounts }: { conversation: Conversation; account?: Account; demo: boolean; draft: string; setDraft: Dispatch<SetStateAction<string>>; onSend: AppShellProps['onSendMessage']; onTyping: AppShellProps['onSetTyping']; onOpenAccounts(event?: MouseEvent<HTMLElement>): void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [emojisOpen, setEmojisOpen] = useState(false);
  const emojiInsertion = useRef<number | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const accountReady = demo || account?.status === 'connected';
  const canSend = conversation.capabilities.sendMessages && accountReady;

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft.trim() || sending || !canSend) return;
    const text = draft.trim(); setSending(true); setError('');
    try { await onSend(conversation.id, text); setDraft((current) => current.trim() === text ? '' : current); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Your message could not be confirmed. Check its status before sending again.'); }
    finally { setSending(false); textRef.current?.focus(); }
  }
  useEffect(() => { if (textRef.current) { textRef.current.style.height = 'auto'; textRef.current.style.height = `${Math.min(textRef.current.scrollHeight, 150)}px`; } }, [draft]);

  function insertEmoji(emoji: string) {
    const start = textRef.current?.selectionStart ?? draft.length;
    const end = textRef.current?.selectionEnd ?? start;
    if (draft.length - (end - start) + emoji.length > 10000) return;
    setDraft((text) => text.slice(0, start) + emoji + text.slice(end));
    emojiInsertion.current = start + emoji.length;
    setEmojisOpen(false);
  }

  return <div className="composer-area"><form className={cn('composer', !canSend && 'composer-disabled')} onSubmit={(event) => void send(event)}>
    <label className="sr-only" htmlFor="message-composer">{demo ? 'Write a demo message' : `Message ${conversation.title}`}</label>
    <textarea id="message-composer" ref={textRef} value={draft} rows={1} maxLength={10000}
      placeholder={!canSend ? !accountReady ? 'Reconnect this account to send messages…' : 'Messaging is unavailable in this conversation.' : demo ? `Write a demo message to ${conversation.title}…` : `Message ${conversation.title}…`}
      disabled={!canSend} aria-describedby="composer-guidance" dir="auto"
      onChange={(event) => { setDraft(event.target.value); setError(''); if (conversation.capabilities.typing && Date.now() - lastTyping.current > 3500) { lastTyping.current = Date.now(); onTyping(conversation.id); } }}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
    <div className="composer-toolbar"><div className="composer-tools">
      <UnavailableAction label="File attachments are not available in this preview"><Paperclip /></UnavailableAction>
      <Popover.Root open={emojisOpen} onOpenChange={(open) => { if (open) emojiInsertion.current = null; setEmojisOpen(open); }}>
        <Popover.Trigger asChild><IconButton label="Add an emoji" disabled={!canSend}><Smile /></IconButton></Popover.Trigger>
        <Popover.Portal><Popover.Content className="emoji-picker" side="top" align="start" sideOffset={10} collisionPadding={12} aria-label="Choose an emoji"
          onCloseAutoFocus={(event) => { if (emojiInsertion.current !== null) { event.preventDefault(); const position = emojiInsertion.current; requestAnimationFrame(() => { textRef.current?.focus(); textRef.current?.setSelectionRange(position, position); }); } }}>
          {['😊', '👍', '🎉', '💜', '👋', '✨', '☕', '🙌'].map((emoji) => <button type="button" key={emoji} aria-label={`Insert ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </div><div className="composer-send-side">
      {draft.length >= 9000 && <span className="draft-limit" role="status">{draft.length.toLocaleString()} / 10,000</span>}
      <span className="send-provider"><ProviderIcon provider={conversation.provider} />{demo ? 'Demo only' : conversation.provider === 'skype' ? 'Skype' : 'Teamwire'}</span>
      <Button type="submit" className="send-button" size="icon" aria-label={demo ? 'Send demo message' : `Send message via ${providerName(conversation.provider)}`} disabled={!canSend || !draft.trim() || sending}>{sending ? <LoaderCircle className="spin" /> : <ArrowUp />}</Button>
    </div></div>
  </form><div className="composer-footnote" id="composer-guidance"><span>{demo ? <><FlaskConical />Demo messages stay in this workspace.</> : !accountReady ? <button type="button" onClick={onOpenAccounts}>Manage account connection<ArrowRight /></button> : !canSend ? 'Messaging is unavailable in this conversation.' : <><ProviderIcon provider={conversation.provider} />{account?.address || account?.label || providerName(conversation.provider)}</>}</span><span><kbd>Enter</kbd> to send<span className="text-dot">·</span><kbd>Shift Enter</kbd> for a new line</span></div>{error && <p className="composer-error" role="alert">{error}</p>}</div>;
}

function ConversationDetails({ conversation, account, messages, demo, onClose, onTogglePinned, onOpenAccounts }: { conversation: Conversation; account?: Account; messages: ChatMessage[]; demo: boolean; onClose(): void; onTogglePinned(): void; onOpenAccounts(event?: MouseEvent<HTMLElement>): void }) {
  const attachments = messages.flatMap((message) => message.attachments ?? []);
  const [tab, setTab] = useState<'overview' | 'files'>('overview');
  return <aside className="conversation-details" aria-label="Conversation details" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}><div className="details-heading"><span>Conversation details</span><IconButton label="Close conversation details" onClick={onClose}><PanelRightClose /></IconButton></div><div className="details-scroll"><div className="details-profile"><Avatar initials={conversation.initials} color={conversation.color} group={conversation.group} className="profile-avatar" /><h3>{conversation.title}</h3><span>{conversation.group ? `${conversation.participants.length} people · Group conversation` : demo ? 'Sample contact' : 'Work conversation'}</span><div className="profile-provider"><ProviderIcon provider={conversation.provider} />{providerName(conversation.provider)}</div><button type="button" className={cn('pin-conversation', conversation.pinned && 'is-pinned')} aria-pressed={conversation.pinned} onClick={onTogglePinned}><Star />{conversation.pinned ? 'Pinned conversation' : 'Pin conversation'}</button></div><div className="details-tabs" role="tablist" aria-label="Conversation information" onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'files' : tab === 'overview' ? 'files' : 'overview'; setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus(); }}><button type="button" role="tab" tabIndex={tab === 'overview' ? 0 : -1} aria-selected={tab === 'overview'} aria-controls="details-overview" id="overview-tab" className={cn(tab === 'overview' && 'is-active')} onClick={() => setTab('overview')}>Overview</button><button type="button" role="tab" tabIndex={tab === 'files' ? 0 : -1} aria-selected={tab === 'files'} aria-controls="details-files" id="files-tab" className={cn(tab === 'files' && 'is-active')} onClick={() => setTab('files')}>Files{attachments.length > 0 && <span>{attachments.length}</span>}</button></div>
      {tab === 'overview' ? <div id="details-overview" role="tabpanel" aria-labelledby="overview-tab"><section className="detail-section"><span className="eyebrow">IN THIS CONVERSATION</span><div className="detail-provider-account"><ProviderIcon provider={conversation.provider} /><div><strong>{account?.label || providerName(conversation.provider)}</strong><span>{account?.address || 'No account connected'}</span></div>{account && <ConnectionDot status={account.status} />}</div><button type="button" className="detail-text-action" onClick={onOpenAccounts}>Manage account<ChevronRight /></button></section>{conversation.group && <section className="detail-section"><span className="eyebrow">PEOPLE · {conversation.participants.length}</span><div className="participant-list">{conversation.participants.map((participant, index) => <div key={`${participant}-${index}`}><Avatar initials={initialsFor(participant)} color={['sage', 'violet', 'peach'][index % 3]} /><span>{participant}</span></div>)}</div></section>}<section className="detail-section"><div className="detail-section-heading"><span className="eyebrow">SHARED FILES</span>{attachments.length > 0 && <button type="button" onClick={() => { setTab('files'); requestAnimationFrame(() => document.getElementById('files-tab')?.focus()); }}>View all<ChevronRight /></button>}</div>{attachments.length ? <div className="detail-attachments">{attachments.slice(0, 3).map((attachment) => <AttachmentTile key={attachment.id} attachment={attachment} compact />)}</div> : <div className="details-no-files"><Paperclip /><p>No files in this conversation yet.</p></div>}</section><div className="details-account-note"><ShieldCheck /><p>{demo ? 'A sample conversation to help you feel at home. Nothing here is connected to a real account.' : 'Sent through your ' + providerName(conversation.provider) + ' account. Messages are not forwarded to your other accounts.'}</p></div></div> : <div id="details-files" role="tabpanel" aria-labelledby="files-tab" className="detail-section">{attachments.length ? <div className="detail-attachments">{attachments.map((attachment) => <AttachmentTile key={attachment.id} attachment={attachment} compact />)}</div> : <div className="details-no-files"><Paperclip /><p>No shared files in this conversation yet.</p></div>}{attachments.length > 0 && <p className="file-preview-note">{demo ? 'Sample file details. No files are downloaded from this demo.' : 'File details only. Downloads are not available in this preview.'}</p>}</div>}
    </div><div className="details-footer"><span className="tiny-river-mark"><ChattahoocheeMark /></span><span>A little more connected.</span></div></aside>;
}

function ConnectionBanner({ account, onOpenAccounts }: { account: Account; onOpenAccounts(event?: MouseEvent<HTMLElement>): void }) { return <div className={cn('connection-banner', account.status === 'error' && 'connection-banner-error')} role="status">{account.status === 'connecting' ? <LoaderCircle className="spin" /> : <WifiOff />}<span>{account.status === 'connecting' ? `Connecting ${account.label}…` : account.status === 'error' ? 'This account is disconnected. Check its connection in settings.' : 'This account is offline.'}</span><button type="button" onClick={onOpenAccounts}>{account.status === 'connecting' ? 'View account' : 'Reconnect'}<ArrowRight /></button></div>; }

function Welcome({ demo, hasAccounts, onOpenAccounts, onEnterDemo, onNewChat }: { demo: boolean; hasAccounts: boolean; onOpenAccounts(event?: MouseEvent<HTMLElement>): void; onEnterDemo(): void; onNewChat(): void }) { return <div className="welcome-screen"><div className="welcome-orbit"><span className="orbit-line orbit-one" /><span className="orbit-line orbit-two" /><span className="orbit-sparkle"><Sparkles /></span><span className="orbit-provider orbit-skype"><ProviderIcon provider="skype" /></span><span className="welcome-logo"><ChattahoocheeMark /></span><span className="orbit-provider orbit-teamwire"><ProviderIcon provider="teamwire" /></span><span className="orbit-dot" /></div><span className="eyebrow">A CALMER KIND OF CONNECTED</span><h2>Your conversations.<br /><span>In good company.</span></h2><p>{hasAccounts ? 'Choose a conversation on the left, or start something new.' : 'Connect Skype for Business or Teamwire to see your conversations here. Each message is sent through its own account.'}</p><Button className="welcome-connect" onClick={hasAccounts ? onNewChat : onOpenAccounts}>{hasAccounts ? 'Start a conversation' : 'Connect your first account'}<ArrowRight /></Button>{!demo && !hasAccounts && <button type="button" className="explore-demo" onClick={onEnterDemo}><FlaskConical />Take a look around<span>Explore demo</span><ArrowRight /></button>}<div className="welcome-promises"><span><MessagesSquare />One unified inbox</span><span><ShieldCheck />Separate accounts</span><span><Sun />Room to focus</span></div><div className="welcome-bottom"><span className="chatta-wordmark">chattahoochee</span><span>Good conversations start here.</span></div></div>; }
