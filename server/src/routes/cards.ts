import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { cellStatus, monthOf, monthWindow, resolveDueDate, type PaidBy, type CellStatus } from '../cards.js';

interface CardRow {
  account_id: number;
  name: string;
  mask: string | null;
  source_label: string;
  item_id: number;
  institution_name: string;
  item_status: string;
  last_synced_at: string | null;
  liabilities_status: string | null;
}

interface LiabilityRow {
  account_id: number;
  next_payment_due_date: string | null;
  last_payment_date: string | null;
  last_payment_amount: number | null;
  last_statement_issue_date: string | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  is_overdue: number | null;
  fetched_at: string;
}

interface EventRow {
  account_id: number;
  kind: 'payment' | 'due';
  event_date: string;
  amount: number | null;
}

interface OverrideRow {
  account_id: number;
  month: string;
  paid: number;
}

const CARDS_SQL = `
  SELECT a.id AS account_id, a.name, a.mask, a.source_label,
         i.id AS item_id, i.institution_name, i.status AS item_status,
         i.last_synced_at, i.liabilities_status
  FROM accounts a JOIN items i ON i.id = a.item_id
  WHERE a.type = 'credit'
  ORDER BY a.source_label, a.id
`;

export function cardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get('/api/cards/dashboard', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const months = monthWindow(today, 2, 1);

    const cards = db.prepare(CARDS_SQL).all() as CardRow[];
    const liabilities = db.prepare('SELECT * FROM account_liabilities').all() as LiabilityRow[];
    const events = db.prepare('SELECT * FROM card_events').all() as EventRow[];
    const overrides = db.prepare('SELECT * FROM card_payment_overrides').all() as OverrideRow[];

    const liabByAcct = new Map(liabilities.map((l) => [l.account_id, l]));
    const evByAcct = groupBy(events, (e) => e.account_id);
    const ovByAcct = groupBy(overrides, (o) => o.account_id);

    return {
      months,
      cards: cards.map((c) => {
        const liab = liabByAcct.get(c.account_id) ?? null;
        const evs = evByAcct.get(c.account_id) ?? [];
        const ovs = ovByAcct.get(c.account_id) ?? [];

        const cells = months.map((month) => {
          // Latest 'due' event landing in this month, and any 'payment' in it.
          const dueEvent = latest(evs.filter((e) => e.kind === 'due' && monthOf(e.event_date) === month));
          const payEvent = latest(evs.filter((e) => e.kind === 'payment' && monthOf(e.event_date) === month));
          const override = ovs.find((o) => o.month === month);

          const dueDate = resolveDueDate(month, dueEvent?.event_date ?? null, liab?.next_payment_due_date ?? null);
          // Balance owed for the statement behind this due (event snapshot, or the
          // live liability when the due comes from next_payment_due_date).
          let statementBalance: number | null = null;
          if (dueEvent && dueEvent.event_date === dueDate) statementBalance = dueEvent.amount;
          else if (liab && liab.next_payment_due_date === dueDate) statementBalance = liab.last_statement_balance;

          const { status, paidBy } = cellStatus({
            today,
            dueDate,
            override: override ? override.paid === 1 : null,
            liabilityPaid: payEvent !== null,
            statementBalance,
          });

          return {
            month,
            due_date: dueDate,
            status: status as CellStatus,
            paid_by: paidBy as PaidBy,
            payment: payEvent ? { date: payEvent.event_date, amount: payEvent.amount } : null,
          };
        });

        return {
          account_id: c.account_id,
          name: c.name,
          mask: c.mask,
          source_label: c.source_label,
          item_id: c.item_id,
          institution_name: c.institution_name,
          item_status: c.item_status,
          last_synced_at: c.last_synced_at,
          liabilities_status: c.liabilities_status,
          liabilities: liab && {
            next_payment_due_date: liab.next_payment_due_date,
            minimum_payment_amount: liab.minimum_payment_amount,
            last_statement_balance: liab.last_statement_balance,
            is_overdue: liab.is_overdue,
            fetched_at: liab.fetched_at,
          },
          cells,
        };
      }),
    };
  });

  app.patch('/api/cards/:accountId/override', async (req, reply) => {
    const accountId = Number((req.params as { accountId: string }).accountId);
    const { month, paid } = (req.body ?? {}) as { month?: string; paid?: boolean | null };
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return reply.code(400).send({ error: 'month required (YYYY-MM)' });
    }
    const acct = db
      .prepare("SELECT id FROM accounts WHERE id = ? AND type = 'credit'")
      .get(accountId) as { id: number } | undefined;
    if (!acct) return reply.code(404).send({ error: 'credit account not found' });

    if (paid === null || paid === undefined) {
      db.prepare('DELETE FROM card_payment_overrides WHERE account_id = ? AND month = ?').run(accountId, month);
    } else {
      db.prepare(`
        INSERT INTO card_payment_overrides (account_id, month, paid) VALUES (?, ?, ?)
        ON CONFLICT(account_id, month) DO UPDATE SET paid = excluded.paid, updated_at = datetime('now')
      `).run(accountId, month, paid ? 1 : 0);
    }
    return { ok: true };
  });
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Most recent by event_date (lexicographic works for YYYY-MM-DD), or null. */
function latest(events: EventRow[]): EventRow | null {
  if (events.length === 0) return null;
  return events.reduce((a, b) => (b.event_date > a.event_date ? b : a));
}
