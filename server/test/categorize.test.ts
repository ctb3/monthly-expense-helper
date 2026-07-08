import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { learn, learnIgnore, normalizeMerchant, suggest } from '../src/categorize.js';

describe('normalizeMerchant', () => {
  it('collapses statement noise to a stable key', () => {
    expect(normalizeMerchant('KROGER #123 ANN ARBOR MI')).toBe('KROGER ANN ARBOR MI');
    expect(normalizeMerchant('ACH DEBIT 9354838 COMCAST 8529102 XXXXX8678')).toBe(
      'ACH DEBIT COMCAST',
    );
    expect(normalizeMerchant('UBER *TRIP 8005928996 CA')).toBe('UBER TRIP CA');
    expect(normalizeMerchant('Netflix.com')).toBe('NETFLIX COM');
  });

  it('is idempotent', () => {
    const once = normalizeMerchant('SQ *ANN ARBOR SUMMER F');
    expect(normalizeMerchant(once)).toBe(once);
  });
});

describe('suggest / learn', () => {
  const db = openDb(':memory:');

  it('falls back to the Plaid PFC mapping with low confidence', () => {
    const s = suggest(db, {
      merchant_name: 'Shell',
      name: 'SHELL SERVICE STATION',
      pfc_detailed: 'TRANSPORTATION_GAS',
      pfc_primary: 'TRANSPORTATION',
    });
    expect(s).toEqual({
      category: 'Transportation',
      subcategory: 'Fuel',
      confidence: 'low',
      source: 'plaid',
    });
  });

  it('prefers merchant memory with high confidence after learning', () => {
    const txn = {
      merchant_name: 'Shell',
      name: 'SHELL SERVICE STATION',
      pfc_detailed: 'TRANSPORTATION_GAS',
      pfc_primary: 'TRANSPORTATION',
    };
    learn(db, txn, 'Vacation', 'Transportation');
    const s = suggest(db, txn);
    expect(s).toEqual({
      category: 'Vacation',
      subcategory: 'Transportation',
      confidence: 'high',
      source: 'memory',
    });
  });

  it('returns null with no memory and no mapping', () => {
    expect(
      suggest(db, { merchant_name: null, name: 'MYSTERY VENDOR', pfc_detailed: null, pfc_primary: null }),
    ).toBeNull();
  });

  it('flags card payments and payment-like names as ignorable', () => {
    expect(
      suggest(db, {
        merchant_name: null,
        name: 'CHASE CREDIT CRD EPAY',
        pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        pfc_primary: 'LOAN_PAYMENTS',
      }),
    ).toMatchObject({ ignore: true, source: 'plaid', confidence: 'low' });

    expect(
      suggest(db, {
        merchant_name: null,
        name: 'AUTOMATIC PAYMENT - THANK',
        pfc_detailed: null,
        pfc_primary: null,
      }),
    ).toMatchObject({ ignore: true });
  });

  it('user hide decision beats everything; unhide restores fallback', () => {
    const txn = {
      merchant_name: 'Netflix',
      name: 'NETFLIX.COM',
      pfc_detailed: 'ENTERTAINMENT_TV_AND_MOVIES',
      pfc_primary: 'ENTERTAINMENT',
    };
    learnIgnore(db, txn, true);
    expect(suggest(db, txn)).toMatchObject({ ignore: true, source: 'memory', confidence: 'high' });
    learnIgnore(db, txn, false);
    const s = suggest(db, txn);
    expect(s?.ignore).toBeUndefined();
    expect(s).toMatchObject({ category: 'Luxury', subcategory: 'Streaming' });
  });
});
