import type { PlaidApi, Transaction, AccountBase, RemovedTransaction } from 'plaid';
import type { Db } from '../db/index.js';
import type { Vault } from '../crypto/vault.js';
import { errorMessage } from '../redact.js';

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

interface ItemRow {
  id: number;
  plaid_item_id: string;
  institution_name: string;
  access_token_ciphertext: string;
  cursor: string | null;
}

export async function syncItem(
  db: Db,
  vault: Vault,
  plaid: PlaidApi,
  itemId: number,
): Promise<SyncResult> {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!item) throw new Error(`item ${itemId} not found`);

  const accessToken = vault.decrypt(item.access_token_ciphertext);
  const result: SyncResult = { added: 0, modified: 0, removed: 0 };

  let cursor = item.cursor ?? undefined;
  let hasMore = true;
  while (hasMore) {
    const resp = await plaid.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
    });
    const data = resp.data;
    upsertAccounts(db, item.id, item.institution_name, data.accounts);
    db.transaction(() => {
      for (const t of data.added) {
        upsertTransaction(db, t);
        result.added++;
      }
      for (const t of data.modified) {
        upsertTransaction(db, t);
        result.modified++;
      }
      for (const r of data.removed) {
        applyRemoved(db, r);
        result.removed++;
      }
      cursor = data.next_cursor;
      db.prepare('SELECT 1').get(); // keep transaction non-empty even on empty page
    })();
    hasMore = data.has_more;
  }

  db.prepare(
    "UPDATE items SET cursor = ?, last_synced_at = datetime('now'), status = 'active' WHERE id = ?",
  ).run(cursor ?? null, item.id);
  return result;
}

/**
 * Fetch credit-card liabilities (due dates, last payment) for an item and cache
 * them. Snapshot API, so we also append to card_events for dashboard history.
 * Never throws: the Liabilities product may be unavailable (free trial, missing
 * consent) — on any failure we mark the item 'unavailable' and move on, so the
 * transaction sync it runs alongside is never affected.
 */
export async function syncLiabilities(
  db: Db,
  vault: Vault,
  plaid: PlaidApi,
  itemId: number,
): Promise<'ok' | 'unavailable'> {
  const item = db
    .prepare('SELECT access_token_ciphertext FROM items WHERE id = ?')
    .get(itemId) as { access_token_ciphertext: string } | undefined;
  if (!item) throw new Error(`item ${itemId} not found`);

  try {
    const resp = await plaid.liabilitiesGet({
      access_token: vault.decrypt(item.access_token_ciphertext),
    });
    const credits = resp.data.liabilities.credit ?? [];
    db.transaction(() => {
      for (const c of credits) {
        if (!c.account_id) continue;
        const acct = db
          .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
          .get(c.account_id) as { id: number } | undefined;
        if (!acct) continue;
        upsertLiability(db, acct.id, c);
      }
    })();
    db.prepare("UPDATE items SET liabilities_status = 'ok' WHERE id = ?").run(itemId);
    return 'ok';
  } catch (err) {
    // errorMessage() redacts tokens; never log the raw error object.
    db.prepare("UPDATE items SET liabilities_status = 'unavailable' WHERE id = ?").run(itemId);
    // eslint-disable-next-line no-console
    console.warn(`liabilities unavailable for item ${itemId}: ${errorMessage(err)}`);
    return 'unavailable';
  }
}

interface CreditLiability {
  next_payment_due_date: string | null;
  last_payment_date: string | null;
  last_payment_amount: number | null;
  last_statement_issue_date: string | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  is_overdue: boolean | null;
}

function upsertLiability(db: Db, accountId: number, c: CreditLiability): void {
  db.prepare(`
    INSERT INTO account_liabilities (
      account_id, next_payment_due_date, last_payment_date, last_payment_amount,
      last_statement_issue_date, last_statement_balance, minimum_payment_amount,
      is_overdue, fetched_at
    ) VALUES (@account_id, @next_due, @last_pay_date, @last_pay_amt,
      @last_stmt_date, @last_stmt_bal, @min_pay, @is_overdue, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      next_payment_due_date = excluded.next_payment_due_date,
      last_payment_date = excluded.last_payment_date,
      last_payment_amount = excluded.last_payment_amount,
      last_statement_issue_date = excluded.last_statement_issue_date,
      last_statement_balance = excluded.last_statement_balance,
      minimum_payment_amount = excluded.minimum_payment_amount,
      is_overdue = excluded.is_overdue,
      fetched_at = datetime('now')
  `).run({
    account_id: accountId,
    next_due: c.next_payment_due_date ?? null,
    last_pay_date: c.last_payment_date ?? null,
    last_pay_amt: c.last_payment_amount ?? null,
    last_stmt_date: c.last_statement_issue_date ?? null,
    last_stmt_bal: c.last_statement_balance ?? null,
    min_pay: c.minimum_payment_amount ?? null,
    is_overdue: c.is_overdue === null || c.is_overdue === undefined ? null : c.is_overdue ? 1 : 0,
  });

  // Accumulate history: snapshots only report the latest due/payment.
  const addEvent = db.prepare(`
    INSERT OR IGNORE INTO card_events (account_id, kind, event_date, amount) VALUES (?, ?, ?, ?)
  `);
  if (c.last_payment_date) addEvent.run(accountId, 'payment', c.last_payment_date, c.last_payment_amount ?? null);
  if (c.next_payment_due_date) addEvent.run(accountId, 'due', c.next_payment_due_date, c.last_statement_balance ?? null);
}

function upsertAccounts(db: Db, itemId: number, institutionName: string, accounts: AccountBase[]): void {
  const upsert = db.prepare(`
    INSERT INTO accounts (item_id, plaid_account_id, name, official_name, mask, type, subtype, source_label)
    VALUES (@item_id, @plaid_account_id, @name, @official_name, @mask, @type, @subtype, @source_label)
    ON CONFLICT(plaid_account_id) DO UPDATE SET
      name = excluded.name,
      official_name = excluded.official_name,
      mask = excluded.mask,
      type = excluded.type,
      subtype = excluded.subtype
  `);
  for (const a of accounts) {
    upsert.run({
      item_id: itemId,
      plaid_account_id: a.account_id,
      name: a.name,
      official_name: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ?? null,
      subtype: a.subtype ?? null,
      // Default export label; user edits to match their sheet (e.g. "amex", "pnc cc").
      source_label: institutionName.toLowerCase(),
    });
  }
}

function upsertTransaction(db: Db, t: Transaction): void {
  const account = db
    .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
    .get(t.account_id) as { id: number } | undefined;
  if (!account) return; // account list is upserted before transactions each page

  db.prepare(`
    INSERT INTO transactions (
      plaid_transaction_id, account_id, date, amount, name, merchant_name,
      pfc_primary, pfc_detailed, pending
    ) VALUES (@ptid, @account_id, @date, @amount, @name, @merchant_name, @pfc_primary, @pfc_detailed, @pending)
    ON CONFLICT(plaid_transaction_id) DO UPDATE SET
      date = excluded.date,
      amount = excluded.amount,
      name = excluded.name,
      merchant_name = excluded.merchant_name,
      pfc_primary = excluded.pfc_primary,
      pfc_detailed = excluded.pfc_detailed,
      pending = excluded.pending,
      removed = 0
  `).run({
    ptid: t.transaction_id,
    account_id: account.id,
    date: t.date,
    amount: t.amount,
    name: t.name,
    merchant_name: t.merchant_name ?? null,
    pfc_primary: t.personal_finance_category?.primary ?? null,
    pfc_detailed: t.personal_finance_category?.detailed ?? null,
    pending: t.pending ? 1 : 0,
  });
}

function applyRemoved(db: Db, r: RemovedTransaction): void {
  // Unreviewed rows just disappear (typical pending->posted replacement).
  // Reviewed rows are kept but flagged so review work is never silently lost.
  const row = db
    .prepare('SELECT id, status FROM transactions WHERE plaid_transaction_id = ?')
    .get(r.transaction_id) as { id: number; status: string } | undefined;
  if (!row) return;
  if (row.status === 'new') {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
  } else {
    db.prepare('UPDATE transactions SET removed = 1 WHERE id = ?').run(row.id);
  }
}
