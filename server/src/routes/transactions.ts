import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { suggest, learn, learnIgnore, type TxnForSuggestion } from '../categorize.js';
import { getTaxonomy, isValidPair } from '../taxonomy.js';

interface TxnRow extends TxnForSuggestion {
  id: number;
  account_id: number;
  date: string;
  amount: number;
  category: string | null;
  subcategory: string | null;
  note: string | null;
  status: string;
  pending: number;
  removed: number;
  ignored: number | null;
  source_label: string;
  account_name: string;
  mask: string | null;
}

const LIST_SQL = `
  SELECT t.*, a.source_label, a.name AS account_name, a.mask
  FROM transactions t JOIN accounts a ON a.id = t.account_id
  WHERE t.date >= ? AND t.date <= ?
  ORDER BY a.source_label, t.date, t.id
`;

export function transactionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get('/api/categories', async () => getTaxonomy());

  app.get('/api/transactions', async (req, reply) => {
    const { start, end } = req.query as { start?: string; end?: string };
    if (!start || !end) return reply.code(400).send({ error: 'start and end required (yyyy-mm-dd)' });
    const rows = db.prepare(LIST_SQL).all(start, end) as TxnRow[];
    return rows.map((r) => ({
      ...r,
      // Unset categories surface a live suggestion; saving a category makes it stick.
      suggestion: r.category ? null : suggest(db, r),
    }));
  });

  app.patch('/api/transactions/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as {
      category?: string | null;
      subcategory?: string | null;
      note?: string | null;
      ignored?: boolean | null;
    };
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
      | TxnRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'transaction not found' });

    const category = body.category !== undefined ? body.category : row.category;
    const subcategory = body.subcategory !== undefined ? body.subcategory : row.subcategory;
    const note = body.note !== undefined ? body.note : row.note;

    if (category && subcategory && !isValidPair(category, subcategory)) {
      return reply.code(400).send({ error: `unknown category pair ${category}/${subcategory}` });
    }

    const ignored =
      body.ignored !== undefined ? (body.ignored === null ? null : body.ignored ? 1 : 0) : row.ignored;

    db.prepare(
      'UPDATE transactions SET category = ?, subcategory = ?, note = ?, ignored = ? WHERE id = ?',
    ).run(category, subcategory, note, ignored, id);

    // A user-set complete pair teaches the merchant memory.
    if (body.category !== undefined && category && subcategory) {
      learn(db, row, category, subcategory);
    }
    // An explicit hide/keep decision teaches it too.
    if (typeof body.ignored === 'boolean') {
      learnIgnore(db, row, body.ignored);
    }
    return { ok: true };
  });
}
