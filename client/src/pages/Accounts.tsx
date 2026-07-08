import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { api, type Item } from '../api';
import type { PageProps } from '../App';

interface LaunchState {
  token: string;
  mode: string; // 'new' | item id being re-linked
}

export function Accounts({ onAuthError }: PageProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<Item[]>('/api/items'));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  }, [onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const startLink = async (itemId?: number) => {
    setError(null);
    setBusy(true);
    try {
      const { link_token } = await api<{ link_token: string }>('/api/plaid/link-token', {
        method: 'POST',
        body: itemId ? { itemId } : {},
      });
      setLaunch({ token: link_token, mode: itemId ? String(itemId) : 'new' });
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finishLink = async (publicToken: string | null, institutionName: string | null) => {
    const mode = launch?.mode ?? 'new';
    setLaunch(null);
    try {
      if (mode === 'new' && publicToken) {
        setSyncMsg('Linking and running first sync…');
        const resp = await api<{ item_id: number; sync: { added: number } }>(
          '/api/plaid/exchange',
          { method: 'POST', body: { public_token: publicToken, institution_name: institutionName } },
        );
        setSyncMsg(`Linked. First sync pulled ${resp.sync.added} transactions.`);
      } else if (mode !== 'new') {
        // Update-mode relink: same access token, just resync.
        await api(`/api/items/${mode}/sync`, { method: 'POST' });
        setSyncMsg('Re-linked and synced.');
      }
      await load();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sync = async (itemId: number) => {
    setBusy(true);
    setSyncMsg(null);
    setError(null);
    try {
      const r = await api<{ added: number; modified: number; removed: number }>(
        `/api/items/${itemId}/sync`,
        { method: 'POST' },
      );
      setSyncMsg(`Sync done: ${r.added} added, ${r.modified} modified, ${r.removed} removed.`);
      await load();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Item) => {
    if (
      !window.confirm(
        `Remove ${item.institution_name}? This revokes the Plaid connection and deletes its local transactions.`,
      )
    )
      return;
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="toolbar">
        <button className="primary" disabled={busy || launch !== null} onClick={() => startLink()}>
          + Link institution
        </button>
        {syncMsg && <span className="info">{syncMsg}</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {launch && <PlaidLauncher launch={launch} onDone={finishLink} />}
      {items.length === 0 && (
        <p className="center-note">
          No institutions linked yet. Start with Amex — each link uses one of your 10 Plaid
          free-trial connections (sandbox links are free).
        </p>
      )}
      <HistoryImport onAuthError={onAuthError} />
      {items.map((item) => (
        <div className="card" key={item.id}>
          <div className="card-head">
            <strong>{item.institution_name}</strong>
            <span className="muted">
              {item.last_synced_at ? `last synced ${item.last_synced_at} UTC` : 'never synced'}
            </span>
            <div className="spacer" />
            <button disabled={busy} onClick={() => sync(item.id)}>
              Sync now
            </button>
            <button disabled={busy} onClick={() => startLink(item.id)} title="Re-authenticate">
              Re-link
            </button>
            <button className="danger" disabled={busy} onClick={() => remove(item)}>
              Remove
            </button>
          </div>
          <table className="accounts">
            <thead>
              <tr>
                <th>Account</th>
                <th>Mask</th>
                <th>Type</th>
                <th>
                  Sheet source label{' '}
                  <span className="muted">(the “Source” column in your spreadsheet)</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {item.accounts.map((a) => (
                <AccountRow key={a.id} account={a} onAuthError={onAuthError} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function AccountRow({
  account,
  onAuthError,
}: {
  account: Item['accounts'][number];
  onAuthError: (err: unknown) => boolean;
}) {
  const [label, setLabel] = useState(account.source_label);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (label.trim() === account.source_label) return;
    try {
      await api(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: { source_label: label.trim() },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      onAuthError(err);
    }
  };

  return (
    <tr>
      <td>{account.name}</td>
      <td>{account.mask ?? '—'}</td>
      <td>{account.subtype ?? account.type ?? '—'}</td>
      <td>
        <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={save} />
        {saved && <span className="badge conf-high">saved</span>}
      </td>
    </tr>
  );
}

function HistoryImport({ onAuthError }: PageProps) {
  const [result, setResult] = useState<{
    rows: number;
    merchants: number;
    skipped: number;
    unknownPairs: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const csv = await file.text();
      setResult(await api('/api/import/history', { method: 'POST', body: { csv } }));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card">
      <summary>
        Seed category suggestions from a spreadsheet history CSV{' '}
        <span className="muted">(Date,Price,Category,Subcategory,Source,Note — safe to re-run)</span>
      </summary>
      <p>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </p>
      {busy && <p className="info">Importing…</p>}
      {error && <div className="error">{error}</div>}
      {result && (
        <p className="info">
          Parsed {result.rows} rows, learned {result.merchants} merchants, skipped{' '}
          {result.skipped}.
          {result.unknownPairs.length > 0 && (
            <span className="error"> Unknown pairs: {result.unknownPairs.join(', ')}</span>
          )}
        </p>
      )}
    </details>
  );
}

function PlaidLauncher({
  launch,
  onDone,
}: {
  launch: LaunchState;
  onDone: (publicToken: string | null, institutionName: string | null) => void;
}) {
  const { open, ready } = usePlaidLink({
    token: launch.token,
    onSuccess: (publicToken, metadata) =>
      onDone(publicToken, metadata.institution?.name ?? null),
    onExit: () => onDone(null, null),
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return <p className="info">Opening Plaid Link…</p>;
}
