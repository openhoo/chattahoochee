import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Search, X } from 'lucide-react';
import type { AppShellProps, Contact } from '@/model/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Avatar, IconButton, ProviderIcon, providerName } from './chat-parts';

interface NewConversationDialogProps extends Pick<AppShellProps, 'state' | 'onStartConversation'> { open: boolean; onOpenChange(open: boolean): void; onOpenAccounts(): void }

export function NewConversationDialog({ state, open, onOpenChange, onStartConversation, onOpenAccounts }: NewConversationDialogProps) {
  const [query, setQuery] = useState('');
  const [accountId, setAccountId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const available = state.accounts.filter((account) => account.status === 'connected' || account.status === 'demo');
  const contacts = state.contacts.filter((contact) => (!accountId || contact.accountId === accountId) && `${contact.name} ${contact.address}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (open) { setQuery(''); setError(''); setAccountId(state.accounts.find((account) => account.status === 'connected' || account.status === 'demo')?.id ?? ''); } }, [open]);

  async function start(event?: FormEvent<HTMLFormElement>, contact?: Contact) {
    event?.preventDefault();
    if (pending || (!contact && (!query.trim() || !accountId))) return;
    setPending(true); setError('');
    try { await onStartConversation(contact?.accountId ?? accountId, contact?.address ?? query.trim(), contact?.name); onOpenChange(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to start this conversation.'); }
    finally { setPending(false); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="new-chat-dialog" showCloseButton={false}>
    <DialogHeader className="new-chat-heading"><div><span className="eyebrow">START SOMETHING GOOD</span><DialogTitle>New conversation</DialogTitle></div><IconButton label="Close new conversation" onClick={() => onOpenChange(false)}><X /></IconButton></DialogHeader>
    <DialogDescription>Choose a contact or enter their work address.</DialogDescription>
    {available.length ? <>
      <form onSubmit={(event) => void start(event)} className="new-chat-form"><label className="form-field"><span>Send from</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{available.map((account) => <option key={account.id} value={account.id}>{account.label} · {providerName(account.provider)}</option>)}</select></label><label className="new-chat-search"><Search aria-hidden="true" /><input aria-label="Find a contact or enter an address" placeholder="Name or work address…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></label>{query.includes('@') && <Button type="submit" className="start-address-button" disabled={pending}>{pending ? <LoaderCircle className="spin" /> : <ArrowRight />}Message {query}</Button>}</form>
      <div className="new-chat-contacts"><span className="eyebrow">{query ? 'MATCHING CONTACTS' : 'YOUR CONTACTS'}</span>{contacts.slice(0, 10).map((contact) => <button key={contact.id} type="button" className="contact-picker-item" disabled={pending} onClick={() => void start(undefined, contact)}><Avatar initials={contact.initials} color={contact.color} presence={contact.presence} /><span><strong>{contact.name}</strong><small>{contact.address}</small></span><ProviderIcon provider={contact.provider} /><ArrowRight /></button>)}{!contacts.length && <p className="muted-empty">{query ? 'No matching contacts. Enter a full work address to start a conversation.' : 'Your contacts will appear here once the account has synced.'}</p>}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </> : <div className="new-chat-empty"><div className="provider-pair"><ProviderIcon provider="skype" /><span>+</span><ProviderIcon provider="teamwire" /></div><h3>Connect an account to get started</h3><p>Your contacts and conversations will appear right here.</p><Button onClick={() => { onOpenChange(false); onOpenAccounts(); }}>Connect an account<ArrowRight /></Button></div>}
  </DialogContent></Dialog>;
}
