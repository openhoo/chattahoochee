import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, Eye, EyeOff, FlaskConical, Laptop, LoaderCircle, LogOut, Moon, Plus, ShieldCheck, Sun, X } from 'lucide-react';
import type { AccountInput, AppShellProps, Provider, Theme } from '@/model/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ConnectionDot, IconButton, ProviderIcon, providerName } from './chat-parts';
import './dialog-improvements.css';

interface AccountDialogProps extends Pick<AppShellProps, 'state' | 'onConnectAccount' | 'onDisconnectAccount' | 'onChangeTheme' | 'onEnterDemo' | 'onExitDemo'> {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseAutoFocus?(event: Event): void;
  initialSection?: 'accounts' | 'appearance';
  desktop?: boolean;
}

export function AccountDialog({ state, open, onOpenChange, onCloseAutoFocus, initialSection = 'accounts', desktop = true, onConnectAccount, onDisconnectAccount, onChangeTheme, onEnterDemo, onExitDemo }: AccountDialogProps) {
  const [section, setSection] = useState(initialSection);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<Provider>('skype');
  const [address, setAddress] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [serverTouched, setServerTouched] = useState(false);
  const [invalidAddress, setInvalidAddress] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const restoreSetupFocus = useRef(false);
  const formSession = useRef(0);
  const fieldId = useId();

  function serverProblem(value: string) {
    if (!value.trim()) return provider === 'teamwire' ? 'Enter your organization’s Teamwire HTTPS server.' : '';
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (provider === 'teamwire' && url.pathname !== '/')) {
        return provider === 'teamwire' ? 'Use an HTTPS server address without a path, credentials, query or fragment.' : 'Use an HTTPS discovery URL without credentials, query or fragment.';
      }
      return '';
    } catch { return 'Enter a complete HTTPS address, such as https://messenger.company.com.'; }
  }

  function resetForm() {
    formSession.current += 1;
    setAddress(''); setLoginUsername(''); setPassword(''); setServer(''); setShowPassword(false); setError(''); setServerTouched(false); setInvalidAddress(false);
  }

  function cancelSetup() { resetForm(); setAdding(false); restoreSetupFocus.current = true; }

  function beginSetup() { resetForm(); restoreSetupFocus.current = false; setAdding(true); }

  function chooseProvider(next: Provider) {
    if (next === provider) return;
    resetForm(); setProvider(next);
  }

  useEffect(() => { if (open) { setSection(initialSection); setError(''); } }, [open, initialSection]);
  useEffect(() => {
    if (!open) { resetForm(); setAdding(false); restoreSetupFocus.current = false; }
  }, [open]);
  useEffect(() => {
    if (!open || section !== 'accounts') return;
    if (adding) addressRef.current?.focus({ preventScroll: true });
    else if (restoreSetupFocus.current) {
      addButtonRef.current?.focus({ preventScroll: true });
      restoreSetupFocus.current = false;
    }
  }, [open, adding, section]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const session = formSession.current;
    setPending(true); setError('');
    const input: AccountInput = { provider, address: address.trim(), password, ...(provider === 'skype' && loginUsername.trim() ? { loginUsername: loginUsername.trim() } : {}), ...(server.trim() ? { server: server.trim() } : {}) };
    try {
      await onConnectAccount(input);
      if (formSession.current === session) cancelSetup();
    } catch (failure) { if (formSession.current === session) setError(failure instanceof Error ? failure.message : 'Unable to connect this account.'); }
    finally { if (formSession.current === session) { setPassword(''); setShowPassword(false); } setPending(false); }
  }

  async function disconnect(id: string) {
    setDisconnecting(id); setError('');
    try { await onDisconnectAccount(id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to disconnect this account.'); }
    finally { setDisconnecting(null); }
  }

  const themes: { id: Theme; label: string; Icon: typeof Sun }[] = [{ id: 'light', label: 'Light', Icon: Sun }, { id: 'dark', label: 'Dark', Icon: Moon }, { id: 'system', label: 'System', Icon: Laptop }];
  const connectingAccount = state.accounts.find(account => account.provider === provider && account.address === address.trim() && account.status === 'connecting');
  const waitingForApproval = state.originApprovals.some(approval => approval.accountId === connectingAccount?.id);
  const visibleServerProblem = serverTouched ? serverProblem(server) : '';

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="settings-dialog dialog-refined" showCloseButton={false} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader className="settings-titlebar"><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><DialogTitle>Workspace settings</DialogTitle></div><IconButton label="Close settings" onClick={() => onOpenChange(false)}><X /></IconButton></DialogHeader>
      <DialogDescription className="sr-only">Connect your messaging accounts and choose the appearance of Chattahoochee.</DialogDescription>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          <button type="button" className={cn(section === 'accounts' && 'is-active')} aria-current={section === 'accounts' ? 'page' : undefined} onClick={() => setSection('accounts')}><span className="settings-nav-icon"><ShieldCheck /></span>Accounts<ChevronDown className="settings-nav-chevron" /></button>
          <button type="button" className={cn(section === 'appearance' && 'is-active')} aria-current={section === 'appearance' ? 'page' : undefined} onClick={() => setSection('appearance')}><span className="settings-nav-icon"><Sun /></span>Appearance</button>
          <div className="settings-nav-footer"><span className="chatta-wordmark">chattahoochee</span><span>One place. Your conversations.</span></div>
        </nav>
        <section className={cn('settings-section', section === 'accounts' && adding && 'is-adding')} aria-label={section === 'accounts' ? 'Messaging accounts' : 'Appearance'}>
          {section === 'accounts' ? <>
            {!adding && <>
              <div className="section-heading"><div><h2>Your accounts</h2><p>Each account keeps its own contacts and conversations.</p></div><Button ref={addButtonRef} variant="outline" className="subtle-button" onClick={beginSetup} disabled={pending || state.mode === 'demo'} title={state.mode === 'demo' ? 'Leave the demo workspace to connect your own account.' : undefined}><Plus />Add account</Button></div>
              {state.mode === 'demo' && <div className="settings-demo-note"><FlaskConical /><div><strong>You’re exploring a demo workspace</strong><p>These are sample accounts. Leave the demo to connect your own.</p><button type="button" onClick={() => { onExitDemo(); onOpenChange(false); }}>Leave demo workspace<ArrowRight /></button></div></div>}
              {pending && <p className="connection-progress" role="status"><LoaderCircle className="spin" />An account connection is still in progress.</p>}
              <div className="account-cards" role="list" aria-label="Accounts in this workspace">{state.accounts.map((account) => <div className="settings-account" role="listitem" key={account.id}>
                <ProviderIcon provider={account.provider} className="provider-large" /><div className="account-card-info"><strong>{account.label || providerName(account.provider)}</strong>{account.label && account.label !== providerName(account.provider) && <span className="account-provider-name">{providerName(account.provider)}</span>}<span className="account-card-address">{account.address}</span><span className={cn('account-status', account.status === 'error' && 'status-error')}><ConnectionDot status={account.status} />{disconnecting === account.id ? 'Disconnecting…' : account.status === 'demo' ? 'Demo account' : account.status === 'connected' ? 'Connected' : account.status === 'connecting' ? 'Connecting…' : account.status === 'error' ? 'Connection failed' : 'Disconnected'}</span>{(account.status === 'connected' || account.status === 'demo') && <span className="account-sync-summary">{state.conversations.filter(conversation => conversation.accountId === account.id).length} conversations · {state.contacts.filter(contact => contact.accountId === account.id).length} contacts</span>}{account.error && <p className="account-error">{account.error}</p>}</div>
                {account.status !== 'demo' && <IconButton label={`Disconnect ${account.address} from ${providerName(account.provider)}`} disabled={Boolean(disconnecting) || account.status === 'connecting' || account.status === 'disconnected'} onClick={() => void disconnect(account.id)}>{disconnecting === account.id ? <LoaderCircle className="spin" /> : <LogOut />}</IconButton>}
              </div>)}</div>
              {!state.accounts.length && <div className="accounts-empty"><div className="provider-pair"><ProviderIcon provider="skype" /><span>+</span><ProviderIcon provider="teamwire" /></div><h3>A home for both your accounts</h3><p>Connect Skype for Business or Teamwire to see your conversations here.</p><Button onClick={beginSetup} disabled={pending}>Connect an account<ArrowRight /></Button></div>}
              <div className="demo-switch"><div><FlaskConical /><span>{state.mode === 'demo' ? 'Your real accounts stay separate from this demo.' : 'Want to have a look around first?'}</span></div>{state.mode !== 'demo' && <button type="button" onClick={() => { onEnterDemo(); onOpenChange(false); }}>Explore demo workspace<ArrowRight /></button>}</div>
              {error && <p className="form-error" role="alert">{error}</p>}
            </>}
            {adding && <form className="connect-form" onSubmit={(event) => void connect(event)} aria-busy={pending}>
              <fieldset className="connect-form-fields" disabled={pending}>
              <legend className="sr-only">Account sign-in details</legend>
              <div className="form-section-title"><div><h2>Connect an account</h2><p>Use the sign-in details from your work messenger.</p></div><IconButton label="Cancel account setup" onClick={cancelSetup} disabled={pending}><X /></IconButton></div>
              {!desktop && <div className="browser-preview-note"><Laptop /><p><strong>You’re in the browser preview.</strong> Open the desktop app to connect a real account. You can explore the demo without entering credentials.</p></div>}
              <div className="provider-chooser" aria-label="Choose messaging service">{(['skype', 'teamwire'] as const).map((item) => <button type="button" key={item} className={cn(provider === item && 'is-active')} aria-pressed={provider === item} onClick={() => chooseProvider(item)} disabled={pending}><ProviderIcon provider={item} /><span>{providerName(item)}</span>{provider === item && <Check />}</button>)}</div>
              <p className="provider-setup-description">{provider === 'skype' ? 'Your sign-in address finds your organization’s services automatically.' : 'Connect to your organization’s Teamwire server using your email and password. Interactive SSO and MFA aren’t supported in this preview.'}</p>
              {provider === 'teamwire' && <div className="form-field"><label htmlFor={`${fieldId}-server`}>Teamwire server</label><input id={`${fieldId}-server`} name="server" type="url" autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="https://messenger.company.com" value={server} onChange={(event) => { setServer(event.target.value); event.currentTarget.setCustomValidity(event.target.value.trim() ? serverProblem(event.target.value) : ''); }} onBlur={() => setServerTouched(true)} onInvalid={() => setServerTouched(true)} aria-invalid={Boolean(visibleServerProblem)} aria-describedby={`${fieldId}-server-help`} required /><small id={`${fieldId}-server-help`} className={cn(visibleServerProblem && 'field-validation')}>{visibleServerProblem || 'Use the HTTPS server address supplied by your organization, without a path.'}</small></div>}
              <div className="form-field"><label htmlFor={`${fieldId}-address`}>Sign-in address</label><input ref={addressRef} id={`${fieldId}-address`} name="address" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="you@company.com" value={address} onChange={(event) => { setAddress(event.target.value); if (invalidAddress) setInvalidAddress(!event.currentTarget.validity.valid); }} onInvalid={() => setInvalidAddress(true)} aria-invalid={invalidAddress} aria-describedby={`${fieldId}-address-help`} required /><small id={`${fieldId}-address-help`} className={cn(invalidAddress && 'field-validation')}>{invalidAddress ? 'Enter your full work address, such as you@company.com.' : provider === 'skype' ? 'Your Skype for Business SIP / sign-in address.' : 'The email address you use to sign in to Teamwire.'}</small></div>
              {provider === 'skype' && <div className="form-field"><label htmlFor={`${fieldId}-username`}>Advanced login username<span className="field-optional">Optional</span></label><input id={`${fieldId}-username`} name="loginUsername" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="DOMAIN\username" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} aria-describedby={`${fieldId}-username-help`} /><small id={`${fieldId}-username-help`}>If your client’s advanced settings use a different username, enter it here. Otherwise leave this empty.</small></div>}
              <div className="form-field"><label htmlFor={`${fieldId}-password`}>Password</label><span className="password-input"><input id={`${fieldId}-password`} name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><IconButton label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)} disabled={pending} aria-pressed={showPassword}>{showPassword ? <EyeOff /> : <Eye />}</IconButton></span></div>
              {provider === 'skype' && <details className="advanced-settings"><summary>Server settings</summary><div className="form-field"><label htmlFor={`${fieldId}-server`}>Discovery URL<span className="field-optional">Optional</span></label><input id={`${fieldId}-server`} name="server" type="url" autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="Automatic discovery" value={server} onChange={(event) => { setServer(event.target.value); event.currentTarget.setCustomValidity(event.target.value.trim() ? serverProblem(event.target.value) : ''); }} onBlur={() => setServerTouched(true)} onInvalid={() => setServerTouched(true)} aria-invalid={Boolean(visibleServerProblem)} aria-describedby={`${fieldId}-server-help`} /><small id={`${fieldId}-server-help`} className={cn(visibleServerProblem && 'field-validation')}>{visibleServerProblem || 'Leave empty for automatic discovery. Use an HTTPS discovery URL only if your administrator supplied one.'}</small></div></details>}
              </fieldset>
              <div className="connect-form-footer">
                <p className="credential-note"><ShieldCheck />Your password stays in memory. Enter it again when you reopen the app.</p>
                {error && <p className="form-error" role="alert">{error}</p>}
                {pending && <p className="connection-progress" role="status"><LoaderCircle className="spin" />{waitingForApproval ? 'Review the sign-in service request to continue.' : `Connecting to ${providerName(provider)}…`}</p>}
                <div className="form-actions"><Button type="button" variant="ghost" onClick={cancelSetup} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending || !address.trim() || !password}>{pending ? <><LoaderCircle className="spin" />Connecting…</> : <>Connect account<ArrowRight /></>}</Button></div>
              </div>
            </form>}
          </> : <>
            <div className="section-heading"><div><h2>Make it feel like home</h2><p>Choose your appearance. Changes apply immediately.</p></div></div>
            <div className="theme-options" role="group" aria-label="Color theme">{themes.map(({ id, label, Icon }) => <button type="button" key={id} className={cn('theme-choice', `theme-choice-${id}`, state.theme === id && 'is-active')} aria-pressed={state.theme === id} onClick={() => onChangeTheme(id)}><span className="theme-preview" aria-hidden="true"><span /><span><i /><i /><i /></span></span><span className="theme-name"><Icon aria-hidden="true" />{label}{state.theme === id && <Check aria-hidden="true" />}</span></button>)}</div>
            <p className="appearance-current" role="status">{themes.find(theme => theme.id === state.theme)?.label} appearance selected.</p>
            <div className="appearance-note"><Moon /><p>System follows the light or dark appearance set on your computer.</p></div>
          </>}
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}
