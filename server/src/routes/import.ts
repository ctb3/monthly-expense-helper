import type { FastifyInstance } from 'fastify';
import { parse } from 'csv-parse/sync';
import type { AppDeps } from '../deps.js';
import { normalizeMerchant } from '../categorize.js';
import { isValidPair } from '../taxonomy.js';

interface HistoryRecord {
  Date?: string;
  Price?: string;
  Category?: string;
  Subcategory?: string;
  Source?: string;
  Note?: string;
}

/**
 * Seed merchant_map from an export of the user's historical spreadsheet
 * (columns: Date,Price,Category,Subcategory,Source,Note). Majority category
 * wins per normalized merchant key. Idempotent: re-import recomputes hits.
 */
export function importRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.post('/api/import/history', async (req, reply) => {
    const { csv } = (req.body ?? {}) as { csv?: string };
    if (!csv) return reply.code(400).send({ error: 'csv required' });

    let records: HistoryRecord[];
    try {
      records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      }) as HistoryRecord[];
    } catch (err) {
      return reply.code(400).send({ error: `CSV parse failed: ${(err as Error).message}` });
    }

    // merchant key -> "Category|Subcategory" -> count
    const votes = new Map<string, Map<string, number>>();
    const unknownPairs = new Set<string>();
    let skipped = 0;

    for (const rec of records) {
      const note = rec.Note ?? '';
      const category = rec.Category ?? '';
      const subcategory = rec.Subcategory ?? '';
      const key = normalizeMerchant(note);
      if (!key || !category || !subcategory) {
        skipped++;
        continue;
      }
      if (!isValidPair(category, subcategory)) {
        unknownPairs.add(`${category}/${subcategory}`);
        skipped++;
        continue;
      }
      const pair = `${category}|${subcategory}`;
      const byPair = votes.get(key) ?? new Map<string, number>();
      byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
      votes.set(key, byPair);
    }

    const upsert = db.prepare(`
      INSERT INTO merchant_map (merchant_key, category, subcategory, hits)
      VALUES (@key, @category, @subcategory, @hits)
      ON CONFLICT(merchant_key) DO UPDATE SET
        category = excluded.category,
        subcategory = excluded.subcategory,
        hits = MAX(hits, excluded.hits),
        last_used = datetime('now')
    `);

    let merchants = 0;
    db.transaction(() => {
      for (const [key, byPair] of votes) {
        let best: { pair: string; count: number } | null = null;
        for (const [pair, count] of byPair) {
          if (!best || count > best.count) best = { pair, count };
        }
        if (!best) continue;
        const [category, subcategory] = best.pair.split('|');
        upsert.run({ key, category, subcategory, hits: best.count });
        merchants++;
      }
    })();

    return {
      rows: records.length,
      merchants,
      skipped,
      unknownPairs: [...unknownPairs],
    };
  });
}
