import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, Eye, EyeOff, FlaskConical, Laptop, LoaderCircle, LogOut, Moon, Plus, ShieldCheck, Sun, X } from 'lucide-react';
import type { AccountInput, AppShellProps, Provider, Theme } from '@/model/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ConnectionDot, IconButton, ProviderIcon, providerName } from './chat-parts';

interface AccountDialogProps extends Pick<AppShellProps, 'state' | 'onConnectAccount' | 'onDisconnectAccount' | 'onChangeTheme' | 'onEnterDemo' | 'onExitDemo'> {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseAutoFocus?(event: Event): void;
  initialSection?: 'accounts' | 'appearance';
}

export function AccountDialog({ state, open, onOpenChange, onCloseAutoFocus, initialSection = 'accounts', onConnectAccount, onDisconnectAccount, onChangeTheme, onEnterDemo, onExitDemo }: AccountDialogProps) {
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

  function resetForm() {
    setAddress(''); setLoginUsername(''); setPassword(''); setServer(''); setShowPassword(false); setError('');
  }

  function cancelSetup() { resetForm(); setAdding(false); }

  function chooseProvider(next: Provider) {
    if (next === provider) return;
    resetForm(); setProvider(next);
  }

  useEffect(() => { if (open) { setSection(initialSection); setError(''); } }, [open, initialSection]);
  useEffect(() => {
    if (!open) cancelSetup();
  }, [open]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    const input: AccountInput = { provider, address: address.trim(), password, ...(provider === 'skype' && loginUsername.trim() ? { loginUsername: loginUsername.trim() } : {}), ...(server.trim() ? { server: server.trim() } : {}) };
    try {
      await onConnectAccount(input);
      cancelSetup();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to connect this account.'); }
    finally { setPassword(''); setShowPassword(false); setPending(false); }
  }

  async function disconnect(id: string) {
    setDisconnecting(id); setError('');
    try { await onDisconnectAccount(id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to disconnect this account.'); }
    finally { setDisconnecting(null); }
  }

  const themes: { id: Theme; label: string; Icon: typeof Sun }[] = [{ id: 'light', label: 'Light', Icon: Sun }, { id: 'dark', label: 'Dark', Icon: Moon }, { id: 'system', label: 'System', Icon: Laptop }];

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="settings-dialog" showCloseButton={false} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader className="settings-titlebar"><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><DialogTitle>Workspace settings</DialogTitle></div><IconButton label="Close settings" onClick={() => onOpenChange(false)}><X /></IconButton></DialogHeader>
      <DialogDescription className="sr-only">Connect your messaging accounts and choose the appearance of Chattahoochee.</DialogDescription>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          <button type="button" className={cn(section === 'accounts' && 'is-active')} onClick={() => setSection('accounts')}><span className="settings-nav-icon"><ShieldCheck /></span>Accounts<ChevronDown className="settings-nav-chevron" /></button>
          <button type="button" className={cn(section === 'appearance' && 'is-active')} onClick={() => setSection('appearance')}><span className="settings-nav-icon"><Sun /></span>Appearance</button>
          <div className="settings-nav-footer"><span className="chatta-wordmark">chattahoochee</span><span>One place. Your conversations.</span></div>
        </nav>
        <section className="settings-section" aria-label={section === 'accounts' ? 'Messaging accounts' : 'Appearance'}>
          {section === 'accounts' ? <>
            <div className="section-heading"><div><h2>Your accounts</h2><p>Bring your work conversations together.</p></div>{!adding && <Button variant="outline" className="subtle-button" onClick={() => { setAdding(true); setError(''); }}><Plus />Add account</Button>}</div>
            {state.mode === 'demo' && <div className="settings-demo-note"><FlaskConical /><div><strong>You’re exploring a demo workspace</strong><p>These are sample accounts. Nothing is sent to a real service.</p></div></div>}
            <div className="account-cards">{state.accounts.map((account) => <div className="settings-account" key={account.id}>
              <ProviderIcon provider={account.provider} className="provider-large" /><div className="account-card-info"><strong>{account.label || providerName(account.provider)}</strong><span>{account.address}</span><span className={cn('account-status', account.status === 'error' && 'status-error')}><ConnectionDot status={account.status} />{account.status === 'demo' ? 'Demo account' : account.status === 'connected' ? 'Connected' : account.status === 'connecting' ? 'Connecting…' : account.status === 'error' ? 'Connection failed' : 'Disconnected'}</span>{account.error && <p className="account-error">{account.error}</p>}</div>
              {account.status !== 'demo' && <IconButton label={`Disconnect ${account.label}`} disabled={disconnecting === account.id || account.status === 'connecting'} onClick={() => void disconnect(account.id)}>{disconnecting === account.id ? <LoaderCircle className="spin" /> : <LogOut />}</IconButton>}
            </div>)}</div>
            {!state.accounts.length && !adding && <div className="accounts-empty"><div className="provider-pair"><ProviderIcon provider="skype" /><span>+</span><ProviderIcon provider="teamwire" /></div><h3>A home for both your accounts</h3><p>Connect Skype for Business or Teamwire to see your conversations here.</p><Button onClick={() => setAdding(true)}>Connect an account<ArrowRight /></Button></div>}
            {adding && <form className="connect-form" onSubmit={(event) => void connect(event)}>
              <div className="form-section-title"><h3>Connect an account</h3><IconButton label="Cancel account setup" onClick={cancelSetup} disabled={pending}><X /></IconButton></div>
              <div className="provider-chooser" aria-label="Choose messaging service">{(['skype', 'teamwire'] as const).map((item) => <button type="button" key={item} className={cn(provider === item && 'is-active')} aria-pressed={provider === item} onClick={() => chooseProvider(item)} disabled={pending}><ProviderIcon provider={item} /><span>{providerName(item)}</span>{provider === item && <Check />}</button>)}</div>
              <label className="form-field"><span>Sign-in address</span><input name="address" type="email" autoComplete="username" placeholder="you@company.com" value={address} onChange={(event) => setAddress(event.target.value)} required disabled={pending} /></label>
              {provider === 'skype' && <label className="form-field"><span>Advanced login username<span className="field-optional">Optional</span></span><input name="loginUsername" autoComplete="off" placeholder="DOMAIN\username" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} disabled={pending} /><small>Use the username from your client’s advanced sign-in settings.</small></label>}
              <label className="form-field"><span>Password</span><span className="password-input"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} /><IconButton label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff /> : <Eye />}</IconButton></span></label>
              {provider === 'teamwire' ? <label className="form-field"><span>Teamwire server</span><input name="server" type="url" placeholder="https://messenger.company.com" value={server} onChange={(event) => setServer(event.target.value)} required disabled={pending} /></label> : <details className="advanced-settings"><summary>Server settings</summary><label className="form-field"><span>Discovery URL<span className="field-optional">Optional</span></span><input name="server" type="url" placeholder="Automatic discovery" value={server} onChange={(event) => setServer(event.target.value)} disabled={pending} /></label></details>}
              <p className="credential-note"><ShieldCheck />Your password isn’t saved to disk. You’ll enter it again next time.</p>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="form-actions"><Button type="button" variant="ghost" onClick={cancelSetup} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending || !address.trim() || !password}>{pending ? <><LoaderCircle className="spin" />Connecting…</> : <>Connect account<ArrowRight /></>}</Button></div>
            </form>}
            {!adding && <div className="demo-switch"><div><FlaskConical /><span>{state.mode === 'demo' ? 'Ready for your own conversations?' : 'Want to have a look around first?'}</span></div><button type="button" onClick={() => { state.mode === 'demo' ? onExitDemo() : onEnterDemo(); onOpenChange(false); }}>{state.mode === 'demo' ? 'Leave demo workspace' : 'Explore demo workspace'}<ArrowRight /></button></div>}
            {error && !adding && <p className="form-error" role="alert">{error}</p>}
          </> : <>
            <div className="section-heading"><div><h2>A little more you</h2><p>Choose a look that feels right.</p></div></div>
            <div className="theme-options" role="group" aria-label="Color theme">{themes.map(({ id, label, Icon }) => <button type="button" key={id} className={cn('theme-choice', `theme-choice-${id}`, state.theme === id && 'is-active')} aria-pressed={state.theme === id} onClick={() => onChangeTheme(id)}><span className="theme-preview"><span /><span><i /><i /><i /></span></span><span className="theme-name"><Icon />{label}{state.theme === id && <Check />}</span></button>)}</div>
            <div className="appearance-note"><Moon /><p>System follows the light or dark appearance set on your computer.</p></div>
          </>}
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}
