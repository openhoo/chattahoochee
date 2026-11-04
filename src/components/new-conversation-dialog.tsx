import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, LoaderCircle, Search, X } from 'lucide-react';
import type { AppShellProps, Contact } from '@/model/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Avatar, IconButton, ProviderIcon, providerName } from './chat-parts';
import './dialog-improvements.css';

interface NewConversationDialogProps extends Pick<AppShellProps, 'state' | 'onStartConversation'> {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenAccounts(): void;
  onCloseAutoFocus?(event: Event): void;
}

export function NewConversationDialog({ state, open, onOpenChange, onStartConversation, onOpenAccounts, onCloseAutoFocus }: NewConversationDialogProps) {
  const [query, setQuery] = useState('');
  const [accountId, setAccountId] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingContact, setPendingContact] = useState('');
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const contactsRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const started = useRef(false);
  const openingAccounts = useRef(false);
  const fieldId = useId();
  const available = state.accounts.filter(account => account.status === 'connected' || account.status === 'demo');
  const selectedAccount = available.find(account => account.id === accountId);
  const search = query.trim().toLowerCase();
  const accountContacts = state.contacts.filter(contact => contact.accountId === accountId);
  const contacts = accountContacts.filter(contact => `${contact.name} ${contact.address}`.toLowerCase().includes(search));
  const canCreate = state.mode === 'live' && selectedAccount?.provider === 'skype';
  const validAddress = /^(?:sips?:)?[^\s@]+@[^\s@]+$/i.test(query.trim());

  useEffect(() => {
    requestVersion.current += 1;
    setPending(false); setPendingContact('');
    if (open) {
      started.current = false;
      openingAccounts.current = false;
      const activeAccount = state.conversations.find(conversation => conversation.id === state.selectedConversationId)?.accountId;
      setQuery(''); setError('');
      setAccountId(available.find(account => account.id === activeAccount)?.id ?? available[0]?.id ?? '');
    }
  }, [open]);

  useEffect(() => {
    if (open && !available.some(account => account.id === accountId)) {
      setAccountId(current => available.some(account => account.id === current) ? current : available[0]?.id ?? ''); setQuery(''); setError('');
    }
  }, [open, accountId, state.accounts]);

  function switchAccount(id: string) {
    setAccountId(id); setQuery(''); setError('');
    searchRef.current?.focus();
  }

  async function start(event?: FormEvent<HTMLFormElement>, contact?: Contact) {
    event?.preventDefault();
    if (pending || !selectedAccount) return;
    const matchingContact = contact ?? ((!canCreate || !validAddress) && search && contacts.length === 1 ? contacts[0] : undefined);
    if (!matchingContact && (!canCreate || !validAddress)) return;
    if (matchingContact && matchingContact.accountId !== accountId) return;
    const version = ++requestVersion.current;
    setPending(true); setPendingContact(matchingContact?.id ?? ''); setError('');
    try {
      await onStartConversation(accountId, matchingContact?.address ?? query.trim(), matchingContact?.name);
      if (requestVersion.current === version) { started.current = true; onOpenChange(false); }
    } catch (failure) {
      if (requestVersion.current === version) setError(failure instanceof Error ? failure.message : 'Unable to start this conversation.');
    } finally {
      if (requestVersion.current === version) { setPending(false); setPendingContact(''); }
    }
  }

  function moveContactFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function closeAutoFocus(event: Event) {
    if (openingAccounts.current) { event.preventDefault(); return; }
    if (!started.current) { onCloseAutoFocus?.(event); return; }
    event.preventDefault();
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea:not(:disabled)');
      if (composer) composer.focus();
      else onCloseAutoFocus?.(event);
    });
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="new-chat-dialog dialog-refined" showCloseButton={false} onCloseAutoFocus={closeAutoFocus}>
    <DialogHeader className="new-chat-heading"><div><span className="eyebrow">A GOOD PLACE TO BEGIN</span><DialogTitle>New conversation</DialogTitle></div><IconButton label="Close new conversation" onClick={() => onOpenChange(false)}><X /></IconButton></DialogHeader>
    <DialogDescription>{state.mode === 'demo' ? 'Choose a sample contact to explore an existing conversation.' : 'Choose the account and person you want to message.'}</DialogDescription>
    {available.length ? <>
      <form onSubmit={(event) => void start(event)} className="new-chat-form" aria-busy={pending}>
        <div className="form-field"><label htmlFor={`${fieldId}-account`}>Send from</label><select id={`${fieldId}-account`} value={accountId} onChange={(event) => switchAccount(event.target.value)} disabled={pending} aria-describedby={`${fieldId}-account-help`}>{available.map(account => <option key={account.id} value={account.id}>{providerName(account.provider)} · {account.address}{account.label && account.label !== providerName(account.provider) ? ` · ${account.label}` : ''}</option>)}</select></div>
        {selectedAccount && <div className="new-chat-account-scope" id={`${fieldId}-account-help`}><ProviderIcon provider={selectedAccount.provider} /><p>Messages use <strong>{providerName(selectedAccount.provider)}</strong> through <strong>{selectedAccount.address}</strong>.</p></div>}
        <label className="new-chat-search"><Search aria-hidden="true" /><input ref={searchRef} aria-label="Find a contact or enter an address" aria-describedby={`${fieldId}-search-help`} placeholder={canCreate ? 'Name or work address…' : 'Search this account’s contacts…'} value={query} onChange={(event) => { setQuery(event.target.value); setError(''); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { const first = contactsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'); if (first) { event.preventDefault(); first.focus(); } } }} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={pending} autoFocus />{query && <IconButton label="Clear contact search" onClick={() => { setQuery(''); setError(''); searchRef.current?.focus(); }} disabled={pending}><X /></IconButton>}</label>
        <p className="new-chat-search-help" id={`${fieldId}-search-help`}>{state.mode === 'demo' ? 'Sample contacts only. No real messages are sent.' : selectedAccount?.provider === 'teamwire' ? 'Teamwire opens existing conversations in this preview. Creating a new Teamwire chat isn’t available yet.' : 'Search this account’s contacts, or enter a full work address to start a chat.'}</p>
        {canCreate && query.includes('@') && <Button type="submit" className="start-address-button" disabled={pending || !validAddress}>{pending && !pendingContact ? <LoaderCircle className="spin" /> : <ArrowRight />}Message {query.trim()}</Button>}
      </form>
      <div className="new-chat-contacts" ref={contactsRef} onKeyDown={moveContactFocus} role="group" aria-label="Contacts for the selected account">
        <div className="contact-results-heading"><span className="eyebrow">{search ? 'MATCHING CONTACTS' : 'YOUR CONTACTS'}</span><span className="contact-result-count" role="status" aria-live="polite">{contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}</span></div>
        {contacts.slice(0, 25).map(contact => <button key={contact.id} type="button" className="contact-picker-item" disabled={pending} aria-busy={pendingContact === contact.id} onClick={() => void start(undefined, contact)}><Avatar initials={contact.initials} color={contact.color} presence={contact.presence} /><span><strong>{contact.name}</strong><small>{contact.address}</small></span><ProviderIcon provider={contact.provider} />{pendingContact === contact.id ? <LoaderCircle className="spin" /> : <ArrowRight />}</button>)}
        {contacts.length > 25 && <p className="muted-empty">Showing 25 of {contacts.length} contacts. Search by name or address to narrow the list.</p>}
        {!contacts.length && <div className="contact-search-empty"><Search aria-hidden="true" /><h3>{search ? 'No matching contacts' : 'No contacts here yet'}</h3><p>{search ? (canCreate ? 'Try another name, or enter a full work address to start a conversation.' : 'Try another name or address in this account.') : 'Contacts will appear here after this account syncs.'}</p>{search && <button type="button" onClick={() => { setQuery(''); searchRef.current?.focus(); }} disabled={pending}>Clear search</button>}</div>}
      </div>
      {pending && <p className="connection-progress" role="status"><LoaderCircle className="spin" />Opening your conversation…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="new-chat-keyboard-hint"><kbd>↓</kbd> to browse contacts <span>·</span><kbd>Enter</kbd> to open</p>
    </> : <div className="new-chat-empty"><div className="provider-pair"><ProviderIcon provider="skype" /><span>+</span><ProviderIcon provider="teamwire" /></div><h3>{state.accounts.length ? 'No connected accounts' : 'Connect an account to get started'}</h3><p>{state.accounts.length ? 'Connect a work account before starting a conversation. Your disconnected accounts can be managed in settings.' : 'Your contacts and conversations will appear right here.'}</p><Button onClick={() => { openingAccounts.current = true; onOpenChange(false); onOpenAccounts(); }}>Connect an account<ArrowRight /></Button></div>}
  </DialogContent></Dialog>;
}
