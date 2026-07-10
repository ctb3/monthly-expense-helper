import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type StatusResp } from './api';
import { Unlock } from './pages/Unlock';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Accounts } from './pages/Accounts';
import { UpdateButton } from './components/UpdateButton';

type Tab = 'dashboard' | 'transactions' | 'accounts';

export function App() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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

  const syncAll = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const resp = await api<{ results: Array<{ id: number; added?: number; error?: string }> }>(
        '/api/items/sync-all',
        { method: 'POST' },
      );
      const failed = resp.results.filter((r) => r.error).length;
      const added = resp.results.reduce((sum, r) => sum + (r.added ?? 0), 0);
      setSyncMsg(failed ? `Synced with ${failed} error(s), ${added} added.` : `Synced ${added} new transactions.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (!onAuthError(err)) setSyncMsg('Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  if (!status) return <div className="center-note">Loading…</div>;

  if (!unlocked) {
    return (
      <Unlock
        initialized={status.initialized}
        onUnlocked={() => {
          setStatus({ ...status, initialized: true, unlocked: true });
          setUnlocked(true);
          // Monthly workflow starts by pulling fresh data and surfacing any lost auth.
          void syncAll();
        }}
      />
    );
  }

  return (
    <div className="shell">
      <header>
        <h1>Expense Helper</h1>
        <nav>
          {(['dashboard', 'transactions', 'accounts'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        {syncMsg && <span className="info">{syncMsg}</span>}
        <button disabled={syncing} onClick={syncAll} title="Sync all linked institutions">
          {syncing ? 'Syncing…' : 'Sync All'}
        </button>
        <UpdateButton onAuthError={onAuthError} />
        <button className="lock" onClick={lock} title="Lock the vault">
          Lock
        </button>
      </header>
      <main>
        {tab === 'dashboard' && <Dashboard key={refreshKey} onAuthError={onAuthError} />}
        {tab === 'transactions' && <Transactions key={refreshKey} onAuthError={onAuthError} />}
        {tab === 'accounts' && <Accounts key={refreshKey} onAuthError={onAuthError} />}
      </main>
    </div>
  );
}

export interface PageProps {
  onAuthError: (err: unknown) => boolean;
}
