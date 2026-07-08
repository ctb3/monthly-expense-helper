import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { suggest } from '../categorize.js';
import { toDelimited, type ExportFormat, type ExportRow } from '../export.js';

const EXPORT_SQL = `
  SELECT t.date, t.amount, t.category, t.subcategory, t.note, t.name, t.merchant_name,
         t.pfc_primary, t.pfc_detailed, t.ignored, a.source_label
  FROM transactions t JOIN accounts a ON a.id = t.account_id
  WHERE t.date >= @start AND t.date <= @end
    AND t.removed = 0
    AND (@account_id IS NULL OR t.account_id = @account_id)
  ORDER BY a.source_label, t.date, t.id
`;

interface ExportQueryRow {
  date: string;
  amount: number;
  category: string | null;
  subcategory: string | null;
  note: string | null;
  name: string;
  merchant_name: string | null;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  ignored: number | null;
  source_label: string;
}

export function exportRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get('/api/export.csv', async (req, reply) => {
    const { start, end, account_id, format: formatParam } = req.query as {
      start?: string;
      end?: string;
      account_id?: string;
      format?: string;
    };
    if (!start || !end) return reply.code(400).send({ error: 'start and end required (yyyy-mm-dd)' });
    const format: ExportFormat = formatParam === 'tsv' ? 'tsv' : 'csv';

    const rows = db
      .prepare(EXPORT_SQL)
      .all({ start, end, account_id: account_id ? Number(account_id) : null }) as ExportQueryRow[];

    const exportRows: ExportRow[] = [];
    for (const r of rows) {
      // Same fallback the table shows: saved category, else live suggestion, else blank.
      const s = r.category ? null : suggest(db, r);
      // Hidden rows stay out of the sheet: explicit user hide, or auto-detected
      // non-expense (card payment / transfer) the user hasn't overridden.
      const hidden = r.ignored !== null ? r.ignored === 1 : (s?.ignore ?? false);
      if (hidden) continue;
      exportRows.push({
        date: r.date,
        amount: r.amount,
        category: r.category ?? s?.category ?? null,
        subcategory: r.subcategory ?? s?.subcategory ?? null,
        source_label: r.source_label,
        note: r.note || r.merchant_name || r.name,
      });
    }

    const label = account_id
      ? ((db.prepare('SELECT source_label FROM accounts WHERE id = ?').get(Number(account_id)) as
          | { source_label: string }
          | undefined)?.source_label ?? 'account')
      : 'all';
    const filename = `expenses_${label.replace(/[^a-z0-9-]+/gi, '-')}_${start}_${end}.${format}`;

    reply
      .header(
        'content-type',
        format === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8',
      )
      .header('content-disposition', `attachment; filename="${filename}"`);
    return toDelimited(exportRows, format);
  });
}
