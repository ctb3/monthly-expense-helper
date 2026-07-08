import type { PlaidApi, Transaction, AccountBase, RemovedTransaction } from 'plaid';
import type { Db } from '../db/index.js';
import type { Vault } from '../crypto/vault.js';

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
