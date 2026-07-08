import { describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';

function testApp() {
  const config = loadConfig({ DB_PATH: ':memory:', SESSION_TTL_MINUTES: '5' });
  const deps = buildDeps(config, openDb(':memory:'));
  return { app: buildApp(deps), deps };
}

const PASS = 'a-long-enough-passphrase';

describe('auth flow', () => {
  it('blocks API access until unlocked, then allows it, then locks again', async () => {
    const { app } = testApp();

    let res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toEqual({ initialized: false, unlocked: false });

    res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(401);

    // Too-short passphrase rejected at first-time setup
    res = await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: 'short' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: PASS } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'session');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);

    res = await app.inject({
      method: 'GET',
      url: '/api/items',
      cookies: { session: cookie!.value },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    res = await app.inject({
      method: 'POST',
      url: '/api/lock',
      cookies: { session: cookie!.value },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: 'GET',
      url: '/api/items',
      cookies: { session: cookie!.value },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong passphrase after initialization', async () => {
    const { app } = testApp();
    await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: PASS } });
    await app.inject({ method: 'POST', url: '/api/lock' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/unlock',
      payload: { passphrase: 'not-the-passphrase' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests without a session cookie even when unlocked', async () => {
    const { app } = testApp();
    await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: PASS } });
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(401);
  });
});

describe('history import + suggestions end-to-end', () => {
  it('seeds merchant_map and surfaces suggestions on transactions', async () => {
    const { app, deps } = testApp();
    const unlock = await app.inject({
      method: 'POST',
      url: '/api/unlock',
      payload: { passphrase: PASS },
    });
    const session = unlock.cookies.find((c) => c.name === 'session')!.value;

    const csv = [
      'Date,Price,Category,Subcategory,Source,Note',
      '01/03/2025,$1.00,Housing,Rent,pnc,ACH WEB 2K8J07 PL*CMBPropertyMa WEB PMTS',
      '06/28/2026,$165.38,Food,Groceries,amex,KROGER          ANN ARBOR         MI',
      '06/05/2026,$87.35,Food,Groceries,amex,KROGER          ANN ARBOR         MI',
      '06/05/2026,$53.30,Bogus,Nope,amex,SHOULD BE SKIPPED',
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/history',
      cookies: { session },
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.merchants).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.unknownPairs).toEqual(['Bogus/Nope']);

    // Simulate a synced transaction from the same merchant
    deps.db
      .prepare(
        `INSERT INTO items (plaid_item_id, institution_name, access_token_ciphertext) VALUES ('it-1', 'Amex', 'x')`,
      )
      .run();
    deps.db
      .prepare(
        `INSERT INTO accounts (item_id, plaid_account_id, name, source_label) VALUES (1, 'acc-1', 'Blue Cash', 'amex')`,
      )
      .run();
    deps.db
      .prepare(
        `INSERT INTO transactions (plaid_transaction_id, account_id, date, amount, name, merchant_name)
         VALUES ('t-1', 1, '2026-07-01', 42.5, 'KROGER #99 ANN ARBOR MI', 'Kroger Ann Arbor MI')`,
      )
      .run();

    const list = await app.inject({
      method: 'GET',
      url: '/api/transactions?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    const rows = list.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].suggestion).toEqual({
      category: 'Food',
      subcategory: 'Groceries',
      confidence: 'high',
      source: 'memory',
    });

    // Export with NO manual edit: the unsaved suggestion is baked into the CSV.
    const exp = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    const lines = exp.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Price,Category,Subcategory,Source,Note');
    expect(lines[1]).toBe('07/01/2026,42.50,Food,Groceries,amex,Kroger Ann Arbor MI');

    // Manual override persists, wins over the suggestion, and teaches the merchant map.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${rows[0].id}`,
      cookies: { session },
      payload: { category: 'Pet', subcategory: 'Food' },
    });
    expect(patch.statusCode).toBe(200);

    const exp2 = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    expect(exp2.body).toContain('07/01/2026,42.50,Pet,Food,amex,Kroger Ann Arbor MI');

    const learned = deps.db
      .prepare("SELECT category, subcategory FROM merchant_map WHERE merchant_key = 'KROGER ANN ARBOR MI'")
      .get();
    expect(learned).toEqual({ category: 'Pet', subcategory: 'Food' });

    // Invalid pair rejected
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${rows[0].id}`,
      cookies: { session },
      payload: { category: 'Food', subcategory: 'Vet' },
    });
    expect(bad.statusCode).toBe(400);

    // Auto-detected card payment: suggested as ignorable, excluded from export.
    deps.db
      .prepare(
        `INSERT INTO transactions (plaid_transaction_id, account_id, date, amount, name, pfc_primary, pfc_detailed)
         VALUES ('t-2', 1, '2026-07-02', -350, 'AUTOMATIC PAYMENT - THANK', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')`,
      )
      .run();

    const list2 = await app.inject({
      method: 'GET',
      url: '/api/transactions?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    const payment = list2.json().find((t: { name: string }) => t.name.startsWith('AUTOMATIC'));
    expect(payment.suggestion).toMatchObject({ ignore: true });

    const exp3 = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    expect(exp3.body).not.toContain('AUTOMATIC PAYMENT');

    // User un-hides it: appears in export; hides again: gone.
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${payment.id}`,
      cookies: { session },
      payload: { ignored: false },
    });
    const exp4 = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    expect(exp4.body).toContain('AUTOMATIC PAYMENT');

    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${payment.id}`,
      cookies: { session },
      payload: { ignored: true },
    });
    const exp5 = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31',
      cookies: { session },
    });
    expect(exp5.body).not.toContain('AUTOMATIC PAYMENT');

    // TSV format
    const tsv = await app.inject({
      method: 'GET',
      url: '/api/export.csv?start=2026-07-01&end=2026-07-31&format=tsv',
      cookies: { session },
    });
    expect(tsv.headers['content-type']).toContain('tab-separated-values');
    expect(tsv.body.split('\r\n')[0]).toBe('Date\tPrice\tCategory\tSubcategory\tSource\tNote');
  });
});
