import type { FastifyInstance } from 'fastify';
import { CountryCode, Products } from 'plaid';
import type { AppDeps } from '../deps.js';
import { syncItem, syncLiabilities } from '../plaid/sync.js';
import { errorMessage } from '../redact.js';

export function plaidRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, vault, config, plaid } = deps;

  app.post('/api/plaid/link-token', async (req, reply) => {
    const { itemId } = (req.body ?? {}) as { itemId?: number };
    try {
      // No redirect_uri: desktop-web Link handles OAuth institutions (incl. Amex)
      // in a popup. Only mobile webviews would need a registered redirect URI.
      const base = {
        user: { client_user_id: 'local-user' },
        client_name: 'Expense Helper',
        country_codes: [CountryCode.Us],
        language: 'en',
      };
      const resp = itemId
        ? await plaid.linkTokenCreate({
            ...base,
            // Update mode: re-authenticate an existing item. Ask for liabilities
            // consent too, so re-linking an existing card grants the dashboard's
            // due-date data without adding a required product.
            access_token: vault.decrypt(getItemTokenCiphertext(deps, itemId)),
            additional_consented_products: [Products.Liabilities],
          })
        : await plaid.linkTokenCreate({
            ...base,
            products: [Products.Transactions],
            // Optional (not required): institutions lacking liabilities support
            // still link; cards that have it feed the payment dashboard.
            optional_products: [Products.Liabilities],
            transactions: { days_requested: 730 },
          });
      return { link_token: resp.data.link_token };
    } catch (err) {
      req.log.error(`link-token failed: ${errorMessage(err)}`);
      return reply.code(502).send({ error: errorMessage(err) });
    }
  });

  app.post('/api/plaid/exchange', async (req, reply) => {
    const { public_token, institution_name } = (req.body ?? {}) as {
      public_token?: string;
      institution_name?: string;
    };
    if (!public_token) return reply.code(400).send({ error: 'public_token required' });
    try {
      const resp = await plaid.itemPublicTokenExchange({ public_token });
      const ciphertext = vault.encrypt(resp.data.access_token);
      const info = db
        .prepare(
          `INSERT INTO items (plaid_item_id, institution_name, access_token_ciphertext, sort_order)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM items))`,
        )
        .run(resp.data.item_id, institution_name || 'unknown', ciphertext);
      const itemId = Number(info.lastInsertRowid);
      const sync = await syncItem(db, vault, plaid, itemId);
      const liabilities = await syncLiabilities(db, vault, plaid, itemId);
      return { item_id: itemId, sync: { ...sync, liabilities } };
    } catch (err) {
      req.log.error(`token exchange failed: ${errorMessage(err)}`);
      return reply.code(502).send({ error: errorMessage(err) });
    }
  });

  app.get('/api/items', async () => {
    const items = db
      .prepare(
        'SELECT id, institution_name, status, last_synced_at, created_at, sort_order FROM items ORDER BY sort_order, id',
      )
      .all() as Array<Record<string, unknown> & { id: number }>;
    const accounts = db
      .prepare('SELECT id, item_id, name, official_name, mask, type, subtype, source_label FROM accounts')
      .all() as Array<{ item_id: number }>;
    return items.map((it) => ({ ...it, accounts: accounts.filter((a) => a.item_id === it.id) }));
  });

  // Persist a user-chosen institution order. Body: { order: itemId[] }.
  // sort_order is assigned by array position; ids not listed keep their value.
  app.post('/api/items/reorder', async (req, reply) => {
    const { order } = (req.body ?? {}) as { order?: unknown };
    if (!Array.isArray(order) || !order.every((x) => Number.isInteger(x))) {
      return reply.code(400).send({ error: 'order must be an array of item ids' });
    }
    const update = db.prepare('UPDATE items SET sort_order = ? WHERE id = ?');
    db.transaction(() => {
      (order as number[]).forEach((id, i) => update.run(i, id));
    })();
    return { ok: true };
  });

  app.post('/api/items/sync-all', async (req, reply) => {
    const ids = (db.prepare('SELECT id FROM items').all() as Array<{ id: number }>).map((r) => r.id);
    const results: Array<{ id: number; added?: number; error?: string }> = [];
    for (const id of ids) {
      try {
        const sync = await syncItem(db, vault, plaid, id);
        await syncLiabilities(db, vault, plaid, id);
        results.push({ id, added: sync.added });
      } catch (err) {
        req.log.error(`sync-all failed for item ${id}: ${errorMessage(err)}`);
        results.push({ id, error: errorMessage(err) });
      }
    }
    return { results };
  });

  app.post('/api/items/:id/sync', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      const sync = await syncItem(db, vault, plaid, id);
      const liabilities = await syncLiabilities(db, vault, plaid, id);
      return { ...sync, liabilities };
    } catch (err) {
      req.log.error(`sync failed for item ${id}: ${errorMessage(err)}`);
      return reply.code(502).send({ error: errorMessage(err) });
    }
  });

  app.patch('/api/accounts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { source_label } = (req.body ?? {}) as { source_label?: string };
    if (!source_label?.trim()) return reply.code(400).send({ error: 'source_label required' });
    const info = db
      .prepare('UPDATE accounts SET source_label = ? WHERE id = ?')
      .run(source_label.trim(), id);
    if (info.changes === 0) return reply.code(404).send({ error: 'account not found' });
    return { ok: true };
  });

  app.delete('/api/items/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare('SELECT access_token_ciphertext FROM items WHERE id = ?')
      .get(id) as { access_token_ciphertext: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'item not found' });
    try {
      await plaid.itemRemove({ access_token: vault.decrypt(row.access_token_ciphertext) });
    } catch (err) {
      // Still remove locally; the Plaid-side item may already be gone.
      req.log.warn(`plaid itemRemove failed: ${errorMessage(err)}`);
    }
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    return { ok: true };
  });
}

function getItemTokenCiphertext(deps: AppDeps, itemId: number): string {
  const row = deps.db
    .prepare('SELECT access_token_ciphertext FROM items WHERE id = ?')
    .get(itemId) as { access_token_ciphertext: string } | undefined;
  if (!row) throw new Error(`item ${itemId} not found`);
  return row.access_token_ciphertext;
}
