// Single-file DB snapshot for migration. Raw copies of expense.db are near-empty
// because the DB runs in WAL mode (data lives in expense.db-wal); VACUUM INTO
// folds everything into one clean file and is safe while the dev server runs.
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';

const src = process.env.DB_PATH ?? 'var/expense.db';
const out = process.argv[2] ?? 'var/expense-migrate.db';

if (existsSync(out)) unlinkSync(out);
const db = new Database(src, { fileMustExist: true });
db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
const rows = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
db.close();
// eslint-disable-next-line no-console
console.log(`snapshot written: ${out} (${rows.n} transactions)`);
