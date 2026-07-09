import { useCallback, useEffect, useState } from 'react';
import { api, type CardsDashboard, type CardCell, type CardRow } from '../api';
import type { PageProps } from '../App';

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const CELL_CLASS: Record<CardCell['status'], string> = {
  paid: 'cell-paid',
  'due-soon': 'cell-due-soon',
  late: 'cell-late',
  upcoming: 'cell-upcoming',
  unknown: 'cell-unknown',
};

// Manual override only applies to cells not already confirmed paid by the card
// sync. Simple toggle: manually-paid <-> back to synced/auto data.
function nextOverride(cell: CardCell): boolean | null {
  return cell.paid_by === 'override' ? null : true;
}

// A cell settled straight from the card sync is ground truth — locked, no override.
// Either a confirmed payment or a statement that owed nothing.
function isLocked(cell: CardCell): boolean {
  return cell.paid_by === 'liability' || cell.paid_by === 'no-balance';
}

export function Dashboard({ onAuthError }: PageProps) {
  const [data, setData] = useState<CardsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<CardsDashboard>('/api/cards/dashboard'));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  }, [onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycle = async (card: CardRow, cell: CardCell) => {
    try {
      await api(`/api/cards/${card.account_id}/override`, {
        method: 'PATCH',
        body: { month: cell.month, paid: nextOverride(cell) },
      });
      await load();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="center-note">Loading…</div>;
  if (data.cards.length === 0) {
    return (
      <p className="center-note">
        No credit cards linked yet. Link a card on the Accounts tab; payment status shows up here.
      </p>
    );
  }

  return (
    <div>
      <p className="muted">
        Green = paid, yellow = due within a week, red = past due. Click an unconfirmed cell to mark
        it paid; click again to clear. Cells confirmed paid from the card sync are locked.
      </p>
      <div className="table-scroll">
        <table className="dashboard">
          <thead>
            <tr>
              <th>Card</th>
              {data.months.map((m) => (
                <th key={m}>{MONTH_LABEL(m)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.cards.map((card) => (
              <tr key={card.account_id}>
                <td>
                  <div>
                    <strong>{card.source_label}</strong>
                    {card.mask && <span className="muted"> ••{card.mask}</span>}
                  </div>
                  <div className="muted">
                    {card.last_synced_at ? `synced ${card.last_synced_at} UTC` : 'never synced'}
                  </div>
                  {card.liabilities_status !== 'ok' && (
                    <div className="badge conf-low">no due-date data — sync, then re-link if needed</div>
                  )}
                </td>
                {card.cells.map((cell) => {
                  const locked = isLocked(cell);
                  return (
                    <td
                      key={cell.month}
                      className={`cell ${CELL_CLASS[cell.status]}${locked ? ' cell-locked' : ''}`}
                      onClick={locked ? undefined : () => cycle(card, cell)}
                      title={cellTooltip(cell, locked)}
                    >
                      {cell.due_date ? fmtDue(cell.due_date) : '—'}
                      {cell.paid_by === 'override' && <span className="override-dot">•</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtDue(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function cellTooltip(cell: CardCell, locked: boolean): string {
  const parts: string[] = [];
  if (cell.due_date) parts.push(`Due ${cell.due_date}`);
  if (cell.payment) {
    const amt = cell.payment.amount != null ? ` ($${Math.abs(cell.payment.amount).toFixed(2)})` : '';
    parts.push(`Paid ${cell.payment.date}${amt}`);
  }
  if (cell.paid_by === 'no-balance') parts.push('No balance due');
  if (cell.paid_by === 'override') parts.push('(manual override)');
  parts.push(locked ? 'confirmed from card — locked' : 'click to change');
  return parts.join(' · ');
}
