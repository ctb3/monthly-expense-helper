import { describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { cellStatus, resolveDueDate, monthWindow, addDays, daysInMonth } from '../src/cards.js';
import { syncLiabilities } from '../src/plaid/sync.js';

const PASS = 'a-long-enough-passphrase';

function testApp() {
  const config = loadConfig({ DB_PATH: ':memory:', SESSION_TTL_MINUTES: '5' });
  const deps = buildDeps(config, openDb(':memory:'));
  return { app: buildApp(deps), deps };
}

async function unlock(app: ReturnType<typeof testApp>['app']): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: PASS } });
  return res.cookies.find((c) => c.name === 'session')!.value;
}

describe('cards pure logic', () => {
  const today = '2026-07-09';

  it('marks a paid month green regardless of due date', () => {
    expect(cellStatus({ today, dueDate: '2026-07-05', override: null, liabilityPaid: true, statementBalance: null }))
      .toEqual({ status: 'paid', paidBy: 'liability' });
  });

  it('override wins over auto detection in both directions', () => {
    // forced paid despite no payment
    expect(cellStatus({ today, dueDate: '2026-07-05', override: true, liabilityPaid: false, statementBalance: null }))
      .toEqual({ status: 'paid', paidBy: 'override' });
    // forced unpaid despite a payment landing -> falls through to due-date color (past due = late)
    expect(cellStatus({ today, dueDate: '2026-07-05', override: false, liabilityPaid: true, statementBalance: null }))
      .toEqual({ status: 'late', paidBy: null });
  });

  it('colors unpaid cells by due date: late / due-soon / upcoming', () => {
    expect(cellStatus({ today, dueDate: '2026-07-08', override: null, liabilityPaid: false, statementBalance: null }).status).toBe('late');
    // due today is not yet late, and within 7 days -> due-soon
    expect(cellStatus({ today, dueDate: today, override: null, liabilityPaid: false, statementBalance: null }).status).toBe('due-soon');
    // exact 7-day boundary is still due-soon
    expect(cellStatus({ today, dueDate: '2026-07-16', override: null, liabilityPaid: false, statementBalance: null }).status).toBe('due-soon');
    // one day past the boundary is upcoming
    expect(cellStatus({ today, dueDate: '2026-07-17', override: null, liabilityPaid: false, statementBalance: null }).status).toBe('upcoming');
  });

  it('a zero (or negative) statement balance settles the cell green', () => {
    // Nothing owed even though the due date is in the future and no payment posted.
    expect(cellStatus({ today, dueDate: '2026-07-12', override: null, liabilityPaid: false, statementBalance: 0 }))
      .toEqual({ status: 'paid', paidBy: 'no-balance' });
    // Statement credit (overpaid) also counts as settled.
    expect(cellStatus({ today, dueDate: '2026-07-12', override: null, liabilityPaid: false, statementBalance: -50 }).status)
      .toBe('paid');
    // A real balance past due is still late.
    expect(cellStatus({ today, dueDate: '2026-07-08', override: null, liabilityPaid: false, statementBalance: 368.87 }).status)
      .toBe('late');
    // Unknown balance does not settle it.
    expect(cellStatus({ today, dueDate: '2026-07-08', override: null, liabilityPaid: false, statementBalance: null }).status)
      .toBe('late');
  });

  it('no due date and unpaid is neutral unknown', () => {
    expect(cellStatus({ today, dueDate: null, override: null, liabilityPaid: false, statementBalance: null }))
      .toEqual({ status: 'unknown', paidBy: null });
  });

  it('resolveDueDate prefers an in-month event, then in-month liability due', () => {
    expect(resolveDueDate('2026-07', '2026-07-22', '2026-08-22')).toBe('2026-07-22');
    expect(resolveDueDate('2026-07', null, '2026-07-22')).toBe('2026-07-22');
    expect(resolveDueDate('2026-07', null, '2026-08-22')).toBeNull();
    expect(resolveDueDate('2026-07', null, null)).toBeNull();
  });

  it('monthWindow yields back + current + fwd oldest first', () => {
    expect(monthWindow('2026-07-09', 2, 1)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    // crosses a year boundary
    expect(monthWindow('2026-01-15', 2, 1)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('addDays and daysInMonth handle month/year rollover', () => {
    expect(addDays('2026-07-30', 5)).toBe('2026-08-04');
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2024-02')).toBe(29);
  });
});

describe('cards dashboard API', () => {
  function seedCard(deps: ReturnType<typeof testApp>['deps']): number {
    deps.db.prepare(
      `INSERT INTO items (plaid_item_id, institution_name, access_token_ciphertext, last_synced_at, liabilities_status)
       VALUES ('it-1', 'American Express', 'x', '2026-07-08 03:00:00', 'ok')`,
    ).run();
    deps.db.prepare(
      `INSERT INTO accounts (item_id, plaid_account_id, name, mask, type, subtype, source_label)
       VALUES (1, 'acc-1', 'Blue Cash', '1005', 'credit', 'credit card', 'amex')`,
    ).run();
    return 1;
  }

  it('computes per-month cell statuses from liabilities and events', async () => {
    const { app, deps } = testApp();
    const session = await unlock(app);
    const acct = seedCard(deps);

    // Current-cycle liability due next month; a payment posted last month.
    deps.db.prepare(
      `INSERT INTO account_liabilities (account_id, next_payment_due_date, last_payment_date, last_payment_amount)
       VALUES (?, '2026-08-25', '2026-06-20', -512.33)`,
    ).run(acct);
    deps.db.prepare(
      `INSERT INTO card_events (account_id, kind, event_date, amount) VALUES
       (?, 'payment', '2026-06-20', -512.33), (?, 'due', '2026-06-25', 512.33)`,
    ).run(acct, acct);

    const res = await app.inject({ method: 'GET', url: '/api/cards/dashboard', cookies: { session } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cards).toHaveLength(1);
    const card = body.cards[0];
    expect(card.source_label).toBe('amex');
    expect(card.last_synced_at).toBe('2026-07-08 03:00:00');

    const byMonth = Object.fromEntries(card.cells.map((c: { month: string }) => [c.month, c]));
    // June: had a due event and a payment -> paid.
    expect(byMonth['2026-06'].status).toBe('paid');
    expect(byMonth['2026-06'].paid_by).toBe('liability');
    // August: liability due date, no payment -> upcoming (future, >7 days out from a July "now").
    expect(byMonth['2026-08'].due_date).toBe('2026-08-25');
  });

  it('marks a zero-balance statement paid (no payment needed)', async () => {
    const { app, deps } = testApp();
    const session = await unlock(app);
    const acct = seedCard(deps);
    const month = new Date().toISOString().slice(0, 7);

    // A due this month whose statement owed nothing.
    deps.db.prepare(
      `INSERT INTO account_liabilities (account_id, next_payment_due_date, last_statement_balance)
       VALUES (?, ?, 0)`,
    ).run(acct, `${month}-15`);
    deps.db.prepare(
      `INSERT INTO card_events (account_id, kind, event_date, amount) VALUES (?, 'due', ?, 0)`,
    ).run(acct, `${month}-15`);

    const card = (await app.inject({ method: 'GET', url: '/api/cards/dashboard', cookies: { session } })).json().cards[0];
    const cell = card.cells.find((c: { month: string }) => c.month === month);
    expect(cell.status).toBe('paid');
    expect(cell.paid_by).toBe('no-balance');
  });

  it('override PATCH forces paid, then unpaid, then clears', async () => {
    const { app, deps } = testApp();
    const session = await unlock(app);
    const acct = seedCard(deps);

    const patch = (paid: boolean | null) =>
      app.inject({
        method: 'PATCH',
        url: `/api/cards/${acct}/override`,
        cookies: { session },
        payload: { month: '2026-07', paid },
      });

    expect((await patch(true)).statusCode).toBe(200);
    let card = (await app.inject({ method: 'GET', url: '/api/cards/dashboard', cookies: { session } })).json().cards[0];
    let july = card.cells.find((c: { month: string }) => c.month === '2026-07');
    expect(july.status).toBe('paid');
    expect(july.paid_by).toBe('override');

    await patch(false);
    // Forcing unpaid with no due date -> unknown (neutral), override no longer marks paid_by.
    card = (await app.inject({ method: 'GET', url: '/api/cards/dashboard', cookies: { session } })).json().cards[0];
    july = card.cells.find((c: { month: string }) => c.month === '2026-07');
    expect(july.status).toBe('unknown');

    await patch(null);
    const rows = deps.db.prepare('SELECT COUNT(*) AS n FROM card_payment_overrides').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('rejects a bad month and a non-credit account', async () => {
    const { app, deps } = testApp();
    const session = await unlock(app);
    seedCard(deps);
    deps.db.prepare(
      `INSERT INTO accounts (item_id, plaid_account_id, name, type, source_label)
       VALUES (1, 'acc-2', 'Checking', 'depository', 'pnc')`,
    ).run();

    const badMonth = await app.inject({
      method: 'PATCH', url: '/api/cards/1/override', cookies: { session }, payload: { month: 'nope', paid: true },
    });
    expect(badMonth.statusCode).toBe(400);

    const notCredit = await app.inject({
      method: 'PATCH', url: '/api/cards/2/override', cookies: { session }, payload: { month: '2026-07', paid: true },
    });
    expect(notCredit.statusCode).toBe(404);
  });
});

describe('syncLiabilities', () => {
  function seedItem(deps: ReturnType<typeof testApp>['deps']): number {
    // access_token_ciphertext must decrypt, so encrypt a real token via the vault.
    deps.vault.initialize(PASS);
    const ct = deps.vault.encrypt('access-token-1');
    deps.db.prepare(
      `INSERT INTO items (plaid_item_id, institution_name, access_token_ciphertext) VALUES ('it-1', 'Amex', ?)`,
    ).run(ct);
    deps.db.prepare(
      `INSERT INTO accounts (item_id, plaid_account_id, name, type, source_label)
       VALUES (1, 'acc-1', 'Blue Cash', 'credit', 'amex')`,
    ).run();
    return 1;
  }

  it('caches a snapshot, appends events, and marks the item ok', async () => {
    const { deps } = testApp();
    const itemId = seedItem(deps);
    deps.plaid = {
      liabilitiesGet: async () => ({
        data: {
          liabilities: {
            credit: [{
              account_id: 'acc-1',
              next_payment_due_date: '2026-08-25',
              last_payment_date: '2026-07-05',
              last_payment_amount: -400,
              last_statement_issue_date: '2026-07-01',
              last_statement_balance: 400,
              minimum_payment_amount: 35,
              is_overdue: false,
            }],
          },
        },
      }),
    } as never;

    const status = await syncLiabilities(deps.db, deps.vault, deps.plaid, itemId);
    expect(status).toBe('ok');
    const liab = deps.db.prepare('SELECT * FROM account_liabilities WHERE account_id = 1').get() as {
      next_payment_due_date: string; is_overdue: number;
    };
    expect(liab.next_payment_due_date).toBe('2026-08-25');
    expect(liab.is_overdue).toBe(0);
    const events = deps.db.prepare('SELECT kind, event_date FROM card_events ORDER BY kind').all();
    expect(events).toEqual([
      { kind: 'due', event_date: '2026-08-25' },
      { kind: 'payment', event_date: '2026-07-05' },
    ]);
    const item = deps.db.prepare('SELECT liabilities_status FROM items WHERE id = 1').get() as { liabilities_status: string };
    expect(item.liabilities_status).toBe('ok');
  });

  it('marks the item unavailable and does not throw when Plaid errors', async () => {
    const { deps } = testApp();
    const itemId = seedItem(deps);
    deps.plaid = {
      liabilitiesGet: async () => {
        throw new Error('PRODUCTS_NOT_SUPPORTED');
      },
    } as never;

    const status = await syncLiabilities(deps.db, deps.vault, deps.plaid, itemId);
    expect(status).toBe('unavailable');
    const item = deps.db.prepare('SELECT liabilities_status FROM items WHERE id = 1').get() as { liabilities_status: string };
    expect(item.liabilities_status).toBe('unavailable');
  });
});
