// Pure logic for the credit-card payment dashboard. No DB/Plaid access here so
// the status rules stay unit-testable in isolation; routes/cards.ts does the I/O.

export type CellStatus = 'paid' | 'due-soon' | 'late' | 'upcoming' | 'unknown';

export type PaidBy = 'override' | 'liability' | 'no-balance' | null;

/** Days-of-week aside: a plain UTC-date add, YYYY-MM-DD in and out. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Number of days in the given month ('YYYY-MM'). */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Window of months for the grid: `back` previous months + current + `fwd` future
 * months, oldest first. `today` is 'YYYY-MM-DD'.
 */
export function monthWindow(today: string, back: number, fwd: number): string[] {
  const [y, m] = monthOf(today).split('-').map(Number);
  const out: string[] = [];
  for (let i = -back; i <= fwd; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Resolve the due date shown in month M's cell: a 'due' history event dated in M
 * wins; else the liabilities next_payment_due_date if it falls inside M; else null.
 */
export function resolveDueDate(
  month: string,
  dueEventInMonth: string | null,
  liabNextDue: string | null,
): string | null {
  if (dueEventInMonth) return dueEventInMonth;
  if (liabNextDue && monthOf(liabNextDue) === month) return liabNextDue;
  return null;
}

export interface CellInput {
  today: string; // 'YYYY-MM-DD'
  dueDate: string | null; // resolved due date for this cell (may be null)
  override: boolean | null; // from card_payment_overrides: true/false, or null if none
  liabilityPaid: boolean; // a 'payment' event is dated in this month
  // Statement balance for this cycle's due, or null if unknown. <= 0 means nothing
  // was owed (paid-in-full / statement credit), so the cell is settled.
  statementBalance: number | null;
}

export interface CellResult {
  status: CellStatus;
  paidBy: PaidBy;
}

export function cellStatus(i: CellInput): CellResult {
  if (i.override !== null) {
    return { status: i.override ? 'paid' : dueColor(i), paidBy: i.override ? 'override' : null };
  }
  if (i.liabilityPaid) return { status: 'paid', paidBy: 'liability' };
  // A statement that owes nothing is settled — no payment to wait on.
  if (i.statementBalance !== null && i.statementBalance <= 0) {
    return { status: 'paid', paidBy: 'no-balance' };
  }
  return { status: dueColor(i), paidBy: null };
}

/** Color for an unpaid cell based on its due date relative to today. */
function dueColor(i: CellInput): CellStatus {
  if (!i.dueDate) return 'unknown';
  if (i.dueDate < i.today) return 'late';
  if (i.dueDate <= addDays(i.today, 7)) return 'due-soon';
  return 'upcoming';
}
