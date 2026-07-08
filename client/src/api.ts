export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export type Taxonomy = Record<string, string[]>;

export interface Suggestion {
  category: string;
  subcategory: string;
  confidence: 'high' | 'low';
  source: 'memory' | 'plaid';
  ignore?: boolean;
}

export interface Txn {
  id: number;
  date: string;
  amount: number;
  name: string;
  merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
  note: string | null;
  status: 'new' | 'reviewed' | 'exported';
  pending: number;
  removed: number;
  ignored: number | null;
  source_label: string;
  account_name: string;
  mask: string | null;
  suggestion: Suggestion | null;
}

export interface Account {
  id: number;
  item_id: number;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  source_label: string;
}

export interface Item {
  id: number;
  institution_name: string;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  accounts: Account[];
}

export interface StatusResp {
  initialized: boolean;
  unlocked: boolean;
}
