export interface ExportRow {
  date: string; // ISO yyyy-mm-dd from Plaid
  amount: number;
  category: string | null;
  subcategory: string | null;
  source_label: string;
  note: string;
}

export type ExportFormat = 'csv' | 'tsv';

const HEADER = ['Date', 'Price', 'Category', 'Subcategory', 'Source', 'Note'];

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Tabs/newlines can't be escaped in plain TSV; flatten them to spaces. */
function tsvField(value: string): string {
  return value.replace(/[\t\n\r]+/g, ' ');
}

/** yyyy-mm-dd -> MM/DD/YYYY to match the spreadsheet. */
export function toSheetDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

export function toDelimited(rows: ExportRow[], format: ExportFormat): string {
  const delim = format === 'tsv' ? '\t' : ',';
  const field = format === 'tsv' ? tsvField : csvField;
  const lines = [HEADER.join(delim)];
  for (const r of rows) {
    lines.push(
      [
        toSheetDate(r.date),
        r.amount.toFixed(2),
        field(r.category ?? ''),
        field(r.subcategory ?? ''),
        field(r.source_label),
        field(r.note),
      ].join(delim),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function toCsv(rows: ExportRow[]): string {
  return toDelimited(rows, 'csv');
}
