import { useState } from 'react';
import { api } from '../api';

export function Unlock({
  initialized,
  onUnlocked,
}: {
  initialized: boolean;
  onUnlocked: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!initialized && passphrase !== confirm) {
      setError('passphrases do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/api/unlock', { method: 'POST', body: { passphrase } });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="unlock-wrap">
      <form className="unlock-card" onSubmit={submit}>
        <h1>Expense Helper</h1>
        <p>
          {initialized
            ? 'Enter your passphrase to unlock the vault.'
            : 'First run: choose a passphrase (10+ characters). It encrypts your bank access tokens — there is no recovery if forgotten.'}
        </p>
        <input
          type="password"
          autoFocus
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {!initialized && (
          <input
            type="password"
            placeholder="Confirm passphrase"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || passphrase.length === 0}>
          {busy ? 'Working…' : initialized ? 'Unlock' : 'Create vault'}
        </button>
      </form>
    </div>
  );
}
