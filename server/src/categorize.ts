import type { Db } from './db/index.js';

export interface Suggestion {
  category: string;
  subcategory: string;
  confidence: 'high' | 'low';
  source: 'memory' | 'plaid';
  /** True = this row looks like a non-expense (card payment, transfer in) and should be hidden. */
  ignore?: boolean;
}

/**
 * Collapse a raw merchant/statement string to a stable key:
 * uppercase, drop punctuation, masked-digit runs (XXXXX1234), digit runs, extra spaces.
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9&/ ]+/g, ' ')
    .replace(/\bX{2,}[A-Z0-9]*\b/g, ' ')
    .replace(/\b\d[\d/-]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plaid personal_finance_category (detailed, with primary fallback) -> user taxonomy. */
const PFC_MAP: Record<string, [string, string]> = {
  FOOD_AND_DRINK_GROCERIES: ['Food', 'Groceries'],
  FOOD_AND_DRINK_RESTAURANT: ['Food', 'Bar/Restaurant'],
  FOOD_AND_DRINK_FAST_FOOD: ['Food', 'Bar/Restaurant'],
  FOOD_AND_DRINK_COFFEE: ['Food', 'Bar/Restaurant'],
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: ['Food', 'Bar/Restaurant'],
  FOOD_AND_DRINK: ['Food', 'Bar/Restaurant'],
  TRANSPORTATION_GAS: ['Transportation', 'Fuel'],
  TRANSPORTATION_PARKING: ['Transportation', 'Parking'],
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: ['Transportation', 'RideShare'],
  GENERAL_SERVICES_AUTOMOTIVE: ['Transportation', 'Maintenance'],
  TRAVEL_FLIGHTS: ['Vacation', 'Plane'],
  TRAVEL_LODGING: ['Vacation', 'Lodging'],
  TRAVEL_RENTAL_CARS: ['Vacation', 'Transportation'],
  RENT_AND_UTILITIES_RENT: ['Housing', 'Rent'],
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: ['Utility', 'Internet'],
  RENT_AND_UTILITIES_TELEPHONE: ['Utility', 'Cell'],
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: ['Utility', 'Energy'],
  RENT_AND_UTILITIES_WATER: ['Utility', 'Water'],
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: ['Housing', 'Mortgage'],
  MEDICAL_PRIMARY_CARE: ['Health', 'Copay'],
  MEDICAL_DENTAL_CARE: ['Health', 'Copay'],
  MEDICAL_EYE_CARE: ['Health', 'Copay'],
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: ['Health', 'Medicine'],
  MEDICAL_VETERINARY_SERVICES: ['Pet', 'Vet'],
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: ['Fitness', 'Gym/Subscriptions'],
  PERSONAL_CARE_HAIR_AND_BEAUTY: ['Health', 'Hygene'],
  ENTERTAINMENT_TV_AND_MOVIES: ['Luxury', 'Streaming'],
  ENTERTAINMENT_MUSIC_AND_AUDIO: ['Luxury', 'Streaming'],
  ENTERTAINMENT_VIDEO_GAMES: ['Luxury', 'Games'],
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: ['Luxury', 'Events'],
  GENERAL_MERCHANDISE_ELECTRONICS: ['Luxury', 'Electronics'],
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: ['Luxury', 'Clothes'],
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: ['Luxury', 'Gifts'],
  GENERAL_MERCHANDISE_PET_SUPPLIES: ['Pet', 'Food'],
  GENERAL_MERCHANDISE_SUPERSTORES: ['Food', 'Groceries'],
  HOME_IMPROVEMENT_FURNITURE: ['HomeAndGarden', 'Furniture'],
  HOME_IMPROVEMENT_HARDWARE: ['HomeAndGarden', 'Other'],
  HOME_IMPROVEMENT: ['HomeAndGarden', 'Other'],
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: ['Charity', 'Charity'],
  GENERAL_SERVICES_CHILDCARE: ['Kids', 'Kids'],
  GENERAL_SERVICES_EDUCATION: ['Kids', 'Kids'],
};

export interface TxnForSuggestion {
  merchant_name: string | null;
  name: string;
  pfc_detailed: string | null;
  pfc_primary: string | null;
}

export function merchantKeyFor(t: TxnForSuggestion): string {
  return normalizeMerchant(t.merchant_name || t.name);
}

// Non-expense lines: credit-card payments and inbound transfers (card autopay,
// interest credits). Statement text catches what the PFC misses.
const IGNORE_PFC = new Set([
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  'TRANSFER_IN',
]);
const IGNORE_NAME_RE =
  /AUTOMATIC PAYMENT|AUTOPAY|PAYMENT THANK YOU|ONLINE PAYMENT RECEIVED|MOBILE PAYMENT RECEIVED|INTRST PYMNT/i;

const IGNORE_SUGGESTION = (source: 'memory' | 'plaid', confidence: 'high' | 'low'): Suggestion => ({
  category: '',
  subcategory: '',
  confidence,
  source,
  ignore: true,
});

/**
 * Fuzzy memory match for when the exact key misses. Seed data holds full
 * statement descriptors ("PATREON MEMBERSHIP SAN FRANCISCO CA") while live Plaid
 * txns often give a clean brand ("PATREON"); either can be a leading-token prefix
 * of the other. Match on that word boundary, then let the highest-hit
 * category/subcategory pair win. Ignore-flagged rows aren't considered here (hide
 * decisions are learned from live keys, so they exact-match above).
 */
function fuzzyMemoryMatch(db: Db, key: string): Suggestion | null {
  // Single short token (e.g. "CVS") is too generic to prefix-match safely.
  if (key.length < 4) return null;
  const rows = db
    .prepare(
      `SELECT category, subcategory, hits FROM merchant_map
       WHERE category <> '' AND ignore = 0
         AND (merchant_key LIKE @prefix OR @key LIKE (merchant_key || ' %'))`,
    )
    .all({ key, prefix: key + ' %' }) as { category: string; subcategory: string; hits: number }[];
  if (!rows.length) return null;
  const byPair = new Map<string, { category: string; subcategory: string; hits: number }>();
  for (const r of rows) {
    const pair = `${r.category}|${r.subcategory}`;
    const acc = byPair.get(pair);
    if (acc) acc.hits += r.hits;
    else byPair.set(pair, { ...r });
  }
  let best: { category: string; subcategory: string; hits: number } | null = null;
  for (const v of byPair.values()) if (!best || v.hits > best.hits) best = v;
  if (!best) return null;
  return { category: best.category, subcategory: best.subcategory, confidence: 'high', source: 'memory' };
}

export function suggest(db: Db, t: TxnForSuggestion): Suggestion | null {
  const key = merchantKeyFor(t);
  if (key) {
    const hit = db
      .prepare('SELECT category, subcategory, ignore FROM merchant_map WHERE merchant_key = ?')
      .get(key) as { category: string; subcategory: string; ignore: number } | undefined;
    if (hit?.ignore) return IGNORE_SUGGESTION('memory', 'high');
    if (hit && hit.category) {
      return {
        category: hit.category,
        subcategory: hit.subcategory,
        confidence: 'high',
        source: 'memory',
      };
    }
    const fuzzy = fuzzyMemoryMatch(db, key);
    if (fuzzy) return fuzzy;
  }
  if (
    (t.pfc_detailed && IGNORE_PFC.has(t.pfc_detailed)) ||
    (t.pfc_primary && IGNORE_PFC.has(t.pfc_primary)) ||
    IGNORE_NAME_RE.test(t.merchant_name || t.name)
  ) {
    return IGNORE_SUGGESTION('plaid', 'low');
  }
  const mapped =
    (t.pfc_detailed && PFC_MAP[t.pfc_detailed]) ||
    (t.pfc_primary && PFC_MAP[t.pfc_primary]) ||
    null;
  if (mapped) {
    return { category: mapped[0], subcategory: mapped[1], confidence: 'low', source: 'plaid' };
  }
  return null;
}

/** Called whenever the user confirms a category: the map learns and strengthens. */
export function learn(db: Db, t: TxnForSuggestion, category: string, subcategory: string): void {
  const key = merchantKeyFor(t);
  if (!key) return;
  db.prepare(`
    INSERT INTO merchant_map (merchant_key, category, subcategory, ignore)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(merchant_key) DO UPDATE SET
      category = excluded.category,
      subcategory = excluded.subcategory,
      ignore = 0,
      hits = hits + 1,
      last_used = datetime('now')
  `).run(key, category, subcategory);
}

/** User hid (or un-hid) a row: remember the decision for this merchant. */
export function learnIgnore(db: Db, t: TxnForSuggestion, ignore: boolean): void {
  const key = merchantKeyFor(t);
  if (!key) return;
  if (ignore) {
    db.prepare(`
      INSERT INTO merchant_map (merchant_key, category, subcategory, ignore)
      VALUES (?, '', '', 1)
      ON CONFLICT(merchant_key) DO UPDATE SET
        ignore = 1,
        hits = hits + 1,
        last_used = datetime('now')
    `).run(key);
  } else {
    db.prepare("UPDATE merchant_map SET ignore = 0, last_used = datetime('now') WHERE merchant_key = ?").run(key);
  }
}
