import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

// Interactive-hardness scrypt parameters (N=2^15 needs ~32MB; maxmem raised accordingly).
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_LEN = 32;
const IV_LEN = 12;
const SENTINEL = 'expense-helper-vault-v1';

export interface VaultInit {
  saltB64: string;
  verifier: string;
}

function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decryptWithKey(key: Buffer, blob: string): string {
  const [version, ivB64, tagB64, ctB64] = blob.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('malformed ciphertext blob');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Holds the AES key derived from the user's passphrase, in memory only.
 * The app boots locked; every Plaid access token is decrypted on demand.
 */
export class Vault {
  private key: Buffer | null = null;

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** First-run setup: derive a key from the passphrase and produce salt + verifier for storage. */
  initialize(passphrase: string): VaultInit {
    const salt = randomBytes(16);
    this.key = scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);
    return {
      saltB64: salt.toString('base64'),
      verifier: encryptWithKey(this.key, SENTINEL),
    };
  }

  /** Returns false on wrong passphrase (GCM auth failure on the verifier). */
  unlock(passphrase: string, saltB64: string, verifier: string): boolean {
    const candidate = scryptSync(passphrase, Buffer.from(saltB64, 'base64'), KEY_LEN, SCRYPT_PARAMS);
    try {
      if (decryptWithKey(candidate, verifier) !== SENTINEL) return false;
    } catch {
      candidate.fill(0);
      return false;
    }
    this.key = candidate;
    return true;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
  }

  encrypt(plaintext: string): string {
    if (!this.key) throw new Error('vault is locked');
    return encryptWithKey(this.key, plaintext);
  }

  decrypt(blob: string): string {
    if (!this.key) throw new Error('vault is locked');
    return decryptWithKey(this.key, blob);
  }
}
