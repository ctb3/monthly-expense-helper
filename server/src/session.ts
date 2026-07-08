import { randomBytes } from 'node:crypto';

/** In-memory sessions: all invalidated on lock or process restart. */
export class Sessions {
  private tokens = new Map<string, number>(); // token -> expiry epoch ms

  constructor(private ttlMs: number) {}

  create(): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, Date.now() + this.ttlMs);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const expiry = this.tokens.get(token);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.tokens.delete(token);
      return false;
    }
    // Sliding expiry: activity keeps the session alive.
    this.tokens.set(token, Date.now() + this.ttlMs);
    return true;
  }

  destroyAll(): void {
    this.tokens.clear();
  }
}
