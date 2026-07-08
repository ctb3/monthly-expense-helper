import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Item, type Taxonomy, type Txn } from '../api';
import type { PageProps } from '../App';

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

/** Expenses are usually done just after month end, so default to last month. */
function previousMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** If start..end is exactly one whole calendar month, return it for the month input. */
function asWholeMonth(start: string, end: string): string {
  const m = start.slice(0, 7);
  const r = monthRange(m);
  return r.start === start && r.end === end ? m : '';
}

const money = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);

const isHidden = (r: Txn) =>
  r.ignored !== null ? r.ignored === 1 : (r.suggestion?.ignore ?? false);

export function Transactions({ onAuthError }: PageProps) {
  const [{ start, end }, setRange] = useState(monthRange(previousMonth()));
  const [custom, setCustom] = useState(false);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({});
  const [rows, setRows] = useState<Txn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tax, txns, its] = await Promise.all([
        api<Taxonomy>('/api/categories'),
        api<Txn[]>(`/api/transactions?start=${start}&end=${end}`),
        api<Item[]>('/api/items'),
      ]);
      setTaxonomy(tax);
      setRows(txns);
      setItems(its);
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  }, [start, end, onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = useMemo(() => items.flatMap((i) => i.accounts), [items]);
  const hiddenCount = useMemo(() => rows.filter(isHidden).length, [rows]);

  const downloadUrl = (format: 'csv' | 'tsv') =>
    `/api/export.csv?start=${start}&end=${end}&format=${format}${
      accountId ? `&account_id=${accountId}` : ''
    }`;

  return (
    <div>
      <div className="toolbar">
        {!custom ? (
          <input
            type="month"
            value={asWholeMonth(start, end)}
            onChange={(e) => e.target.value && setRange(monthRange(e.target.value))}
          />
        ) : (
          <>
            <input
              type="date"
              value={start}
              onChange={(e) => setRange({ start: e.target.value, end })}
            />
            <span className="muted">to</span>
            <input
              type="date"
              value={end}
              onChange={(e) => setRange({ start, end: e.target.value })}
            />
          </>
        )}
        <button className="chip" onClick={() => setCustom(!custom)}>
          {custom ? 'month' : 'custom range'}
        </button>
        <span className="muted">
          {rows.length} transactions{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
        </span>
        <div className="spacer" />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} title="Export scope">
          <option value="">All cards (combined)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.source_label} {a.mask ? `(…${a.mask})` : ''}
            </option>
          ))}
        </select>
        <DownloadMenu urlFor={downloadUrl} />
      </div>

      {error && <div className="error">{error}</div>}

      <table className="txns">
        <thead>
          <tr>
            <th>Date</th>
            <th>Source</th>
            <th className="num">Price</th>
            <th>Category</th>
            <th>Subcategory</th>
            <th>Note</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <TxnRow key={r.id} row={r} taxonomy={taxonomy} onReload={load} onAuthError={onAuthError} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="center-note">
                No transactions in this range. Sync an account or widen the dates.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DownloadMenu({ urlFor }: { urlFor: (format: 'csv' | 'tsv') => string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="dropdown">
      <button
        className="primary"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        Download ▾
      </button>
      {open && (
        <div className="dropdown-menu">
          <a href={urlFor('csv')} download onClick={() => setOpen(false)}>
            CSV
          </a>
          <a href={urlFor('tsv')} download onClick={() => setOpen(false)}>
            TSV
          </a>
        </div>
      )}
    </div>
  );
}

function TxnRow({
  row,
  taxonomy,
  onReload,
  onAuthError,
}: {
  row: Txn;
  taxonomy: Taxonomy;
  onReload: () => Promise<void>;
  onAuthError: (err: unknown) => boolean;
}) {
  const [category, setCategory] = useState(row.category ?? row.suggestion?.category ?? '');
  const [subcategory, setSubcategory] = useState(
    row.subcategory ?? row.suggestion?.subcategory ?? '',
  );
  const [note, setNote] = useState(row.note ?? row.merchant_name ?? row.name);
  const [error, setError] = useState<string | null>(null);

  const subOptions = taxonomy[category] ?? [];
  const hidden = isHidden(row);
  const autoHidden = row.ignored === null && (row.suggestion?.ignore ?? false);
  const isUnsavedSuggestion = !hidden && !row.category && row.suggestion != null && !row.suggestion.ignore;

  const save = async (patch: {
    category?: string;
    subcategory?: string;
    note?: string;
    ignored?: boolean;
  }) => {
    setError(null);
    try {
      await api(`/api/transactions/${row.id}`, { method: 'PATCH', body: patch });
      if (patch.ignored !== undefined) await onReload();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickCategory = (c: string) => {
    setCategory(c);
    setSubcategory('');
    // Single-subcategory categories (Kids, Charity) complete in one click.
    const subs = taxonomy[c] ?? [];
    if (subs.length === 1) {
      setSubcategory(subs[0]);
      void save({ category: c, subcategory: subs[0], note });
    }
  };

  const pickSubcategory = (s: string) => {
    setSubcategory(s);
    if (category && s) void save({ category, subcategory: s, note });
  };

  return (
    <tr className={hidden ? 'hidden-row' : ''}>
      <td>{row.date}</td>
      <td>
        {row.source_label}
        {row.pending ? <span className="badge pending">pending</span> : null}
        {row.removed ? <span className="badge removed-badge">removed at bank</span> : null}
      </td>
      <td className={`num${row.amount < 0 ? ' refund' : ''}`}>{money(row.amount)}</td>
      <td>
        <select
          className={isUnsavedSuggestion ? 'suggested' : ''}
          value={category}
          onChange={(e) => pickCategory(e.target.value)}
          disabled={hidden}
        >
          <option value="">—</option>
          {Object.keys(taxonomy).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </td>
      <td>
        <select
          className={isUnsavedSuggestion ? 'suggested' : ''}
          value={subcategory}
          onChange={(e) => pickSubcategory(e.target.value)}
          disabled={hidden || !category}
        >
          <option value="">—</option>
          {subOptions.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {isUnsavedSuggestion && (
          <span className={`badge conf-${row.suggestion!.confidence}`}>
            {row.suggestion!.source === 'memory' ? 'from history' : 'plaid guess'}
          </span>
        )}
        {autoHidden && (
          <span className="badge removed-badge">
            auto-hidden ({row.suggestion!.source === 'memory' ? 'from history' : 'payment/transfer'})
          </span>
        )}
        {error && <div className="error">{error}</div>}
      </td>
      <td>
        <input
          className="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (row.note ?? row.merchant_name ?? row.name) && save({ note })}
          disabled={hidden}
        />
      </td>
      <td className="actions">
        {hidden ? (
          <button onClick={() => save({ ignored: false })} title="Include in export again">
            Unhide
          </button>
        ) : (
          <button onClick={() => save({ ignored: true })} title="Exclude from export (learns this merchant)">
            Hide
          </button>
        )}
      </td>
    </tr>
  );
}
