import { describe, expect, it } from 'vitest';
import { toCsv, toDelimited, toSheetDate } from '../src/export.js';

describe('toSheetDate', () => {
  it('converts ISO to MM/DD/YYYY', () => {
    expect(toSheetDate('2026-06-05')).toBe('06/05/2026');
  });
});

describe('toCsv', () => {
  it('matches the spreadsheet column layout', () => {
    const csv = toCsv([
      {
        date: '2026-06-28',
        amount: 165.38,
        category: 'Food',
        subcategory: 'Groceries',
        source_label: 'amex',
        note: 'KROGER ANN ARBOR MI',
      },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Price,Category,Subcategory,Source,Note');
    expect(lines[1]).toBe('06/28/2026,165.38,Food,Groceries,amex,KROGER ANN ARBOR MI');
  });

  it('quotes fields containing commas and quotes, keeps refunds negative', () => {
    const csv = toCsv([
      {
        date: '2026-06-09',
        amount: -18.01,
        category: 'HomeAndGarden',
        subcategory: 'Appliances',
        source_label: 'amazon',
        note: 'stove covers, "return"',
      },
    ]);
    expect(csv).toContain('06/09/2026,-18.01,HomeAndGarden,Appliances,amazon,"stove covers, ""return"""');
  });

  it('tab-delimited output uses tabs and flattens embedded tabs/newlines', () => {
    const tsv = toDelimited(
      [
        {
          date: '2026-06-28',
          amount: 165.38,
          category: 'Food',
          subcategory: 'Groceries',
          source_label: 'amex',
          note: 'KROGER\tANN ARBOR\nMI',
        },
      ],
      'tsv',
    );
    const lines = tsv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date\tPrice\tCategory\tSubcategory\tSource\tNote');
    expect(lines[1]).toBe('06/28/2026\t165.38\tFood\tGroceries\tamex\tKROGER ANN ARBOR MI');
  });
});
