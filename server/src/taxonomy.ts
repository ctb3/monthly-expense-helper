import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Taxonomy = Record<string, string[]>;

let cached: Taxonomy | null = null;

export function getTaxonomy(): Taxonomy {
  if (!cached) {
    const path = fileURLToPath(new URL('../data/taxonomy.json', import.meta.url));
    cached = JSON.parse(readFileSync(path, 'utf8')) as Taxonomy;
  }
  return cached;
}

export function isValidPair(category: string, subcategory: string): boolean {
  return getTaxonomy()[category]?.includes(subcategory) ?? false;
}
