import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type StatusResp } from './api';
import { Unlock } from './pages/Unlock';
import { Transactions } from './pages/Transactions';
import { Accounts } from './pages/Accounts';

type Tab = 'transactions' | 'accounts';

const isOAuthReturn = new URLSearchParams(window.location.search).has('oauth_state_id');

export function App() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState<Tab>(isOAuthReturn ? 'accounts' : 'transactions');

  useEffect(() => {
    api<StatusResp>('/api/status').then((s) => {
      setStatus(s);
      setUnlocked(s.unlocked && document.cookie !== undefined);
    });
  }, []);

  // Any 401 from a page means the session or vault expired: fall back to the unlock screen.
  const onAuthError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setUnlocked(false);
      return true;
    }
    return false;
  }, []);

  const lock = async () => {
    await api('/api/lock', { method: 'POST' }).catch(() => undefined);
    setUnlocked(false);
  };

  if (!status) return <div className="center-note">Loading…</div>;

  if (!unlocked) {
    return (
      <Unlock
        initialized={status.initialized}
        onUnlocked={() => {
          setStatus({ ...status, initialized: true, unlocked: true });
          setUnlocked(true);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <header>
        <h1>Expense Helper</h1>
        <nav>
          {(['transactions', 'accounts'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <button className="lock" onClick={lock} title="Lock the vault">
          Lock
        </button>
      </header>
      <main>
        {tab === 'transactions' && <Transactions onAuthError={onAuthError} />}
        {tab === 'accounts' && <Accounts onAuthError={onAuthError} />}
      </main>
    </div>
  );
}

export interface PageProps {
  onAuthError: (err: unknown) => boolean;
}
