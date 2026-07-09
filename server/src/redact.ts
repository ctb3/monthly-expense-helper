const TOKEN_PATTERNS = [
  /access-(?:sandbox|development|production)-[a-z0-9-]+/gi,
  /link-(?:sandbox|development|production)-[a-z0-9-]+/gi,
  /public-(?:sandbox|development|production)-[a-z0-9-]+/gi,
];

/** Strip Plaid token material from any string destined for logs or client errors. */
export function redact(text: string): string {
  let out = text;
  for (const p of TOKEN_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

/** Plaid `error_code` off an SDK error (`response.data.error_code`), or null. */
export function plaidErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const data = (err as { response?: { data?: { error_code?: string } } }).response?.data;
    if (data?.error_code) return data.error_code;
  }
  return null;
}

/** Safe one-line message from an unknown error, never the full (payload-bearing) object. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    // Plaid SDK errors carry response.data with error_code/error_message.
    const data = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
      .response?.data;
    if (data?.error_code) {
      return redact(`plaid ${data.error_code}: ${data.error_message ?? ''}`);
    }
    if (err instanceof Error) return redact(err.message);
  }
  return redact(String(err));
}
