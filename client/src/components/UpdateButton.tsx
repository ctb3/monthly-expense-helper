import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type UpdateStatusResp } from '../api';

type Phase = 'idle' | 'checking' | 'applying';

interface Msg {
  text: string;
  kind: 'info' | 'error';
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : '?');

export function UpdateButton({ onAuthError }: { onAuthError: (err: unknown) => boolean }) {
  const [status, setStatus] = useState<UpdateStatusResp | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<Msg | null>(null);
  const msgTimer = useRef<number | undefined>(undefined);

  const flash = (text: string, kind: Msg['kind'] = 'info') => {
    window.clearTimeout(msgTimer.current);
    setMsg({ text, kind });
    msgTimer.current = window.setTimeout(() => setMsg(null), 6000);
  };

  const loadStatus = () =>
    api<UpdateStatusResp>('/api/update/status').then(setStatus).catch(() => undefined);

  useEffect(() => {
    void loadStatus();
    // The unlock-triggered server check runs in the background; look again
    // shortly so its result surfaces without a manual click.
    const recheck = window.setTimeout(() => void loadStatus(), 8000);
    return () => {
      window.clearTimeout(recheck);
      window.clearTimeout(msgTimer.current);
    };
  }, []);

  const checkNow = async () => {
    setPhase('checking');
    try {
      const s = await api<UpdateStatusResp>('/api/update/check', { method: 'POST' });
      setStatus(s);
      if (s.error) flash(`Check failed: ${s.error}`, 'error');
      else if (!s.updateAvailable) flash(`Up to date (${shortSha(s.currentSha)})`);
    } catch (err) {
      if (!onAuthError(err)) flash('Update check failed.', 'error');
    } finally {
      setPhase('idle');
    }
  };

  // Wait out the container swap: old server dies (polls fail), new one boots
  // (polls succeed again), then reload onto the fresh client bundle.
  const waitForRestart = async () => {
    const started = Date.now();
    let sawDown = false;
    while (Date.now() - started < 180_000) {
      await new Promise((r) => setTimeout(r, 2000));
      let up = false;
      try {
        up = (await fetch('/api/status', { credentials: 'same-origin' })).ok;
      } catch {
        /* server unreachable */
      }
      if (!up) sawDown = true;
      else if (sawDown) {
        window.location.reload();
        return;
      } else if (Date.now() - started > 90_000) {
        // Never went down: image was already current; watchtower had nothing to do.
        // Force a fresh registry check, not just a status re-read — the cached
        // comparison that made us think an update existed could itself be stale
        // (e.g. mid-cutover to a renamed image), and a plain status re-read would
        // just echo that same stale mismatch back, offering the same no-op
        // "update" forever.
        try {
          const s = await api<UpdateStatusResp>('/api/update/check', { method: 'POST' });
          setStatus(s);
          if (s.error) flash(`Check failed: ${s.error}`, 'error');
          else if (!s.updateAvailable) flash(`Up to date (${shortSha(s.currentSha)})`);
        } catch {
          void loadStatus();
        }
        setPhase('idle');
        return;
      }
    }
    setPhase('idle');
    flash('Update may have stalled — refresh manually.', 'error');
  };

  const applyUpdate = async () => {
    if (!window.confirm('Install the update and restart the app? It will come back locked.')) {
      return;
    }
    setPhase('applying');
    window.clearTimeout(msgTimer.current);
    setMsg({ text: 'Updating — app will restart…', kind: 'info' });
    try {
      await api('/api/update/apply', { method: 'POST' });
    } catch (err) {
      if (err instanceof ApiError) {
        if (!onAuthError(err)) {
          setPhase('idle');
          flash(`Update failed: ${err.message}`, 'error');
        }
        return;
      }
      // Network drop here is expected: watchtower killed the container mid-response.
    }
    await waitForRestart();
  };

  if (!status?.enabled) return null;

  return (
    <>
      {msg && <span className={msg.kind}>{msg.text}</span>}
      {status.updateAvailable && status.applyEnabled ? (
        <button
          disabled={phase !== 'idle'}
          onClick={applyUpdate}
          title={`New version ${shortSha(status.remoteSha)} available (running ${shortSha(status.currentSha)})`}
        >
          {phase === 'applying' ? 'Updating…' : 'Install update'}
        </button>
      ) : (
        <button
          disabled={phase !== 'idle'}
          onClick={checkNow}
          title={`Running ${shortSha(status.currentSha)} — check the registry for a newer image`}
        >
          {phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </>
  );
}
