import { useEffect, useSyncExternalStore } from 'react';
import { AppShell } from './components/app-shell';
import { desktopAvailable } from './lib/native-transport';
import { MessengerStore } from './model/store';
import type { Theme } from './model/types';

const themeKey = 'chattahoochee:theme';
function savedTheme(): Theme {
  try { const value = localStorage.getItem(themeKey); if (value === 'light' || value === 'dark' || value === 'system') return value; }
  catch { /* Preferences are optional when browser storage is unavailable. */ }
  return 'system';
}

export const messenger = new MessengerStore({ demo: new URLSearchParams(location.search).get('demo') === '1', theme: savedTheme() });

export function App() {
  const state = useSyncExternalStore(messenger.subscribe, messenger.getSnapshot);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = state.theme === 'dark' || (state.theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem(themeKey, state.theme); } catch { /* No account data is persisted. */ }
    return () => media.removeEventListener('change', apply);
  }, [state.theme]);

  return <AppShell state={state} desktop={desktopAvailable()}
    onSelectConversation={messenger.selectConversation} onSendMessage={messenger.sendMessage} onSetTyping={messenger.setTyping}
    onConnectAccount={messenger.connectAccount} onDisconnectAccount={messenger.disconnectAccount} onStartConversation={messenger.startConversation}
    onChangeTheme={messenger.setTheme} onTogglePinned={messenger.togglePinned} onEnterDemo={messenger.enterDemo} onExitDemo={messenger.exitDemo}
    onApproveOrigin={messenger.approveOrigin} onDismissNotice={messenger.dismissNotice} />;
}
