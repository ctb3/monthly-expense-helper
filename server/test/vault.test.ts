import { describe, expect, it } from 'vitest';
import { Vault } from '../src/crypto/vault.js';

describe('Vault', () => {
  it('initializes, locks, and unlocks with the right passphrase', () => {
    const v = new Vault();
    expect(v.unlocked).toBe(false);
    const { saltB64, verifier } = v.initialize('correct horse battery staple');
    expect(v.unlocked).toBe(true);

    v.lock();
    expect(v.unlocked).toBe(false);

    expect(v.unlock('wrong passphrase!!', saltB64, verifier)).toBe(false);
    expect(v.unlocked).toBe(false);

    expect(v.unlock('correct horse battery staple', saltB64, verifier)).toBe(true);
    expect(v.unlocked).toBe(true);
  });

  it('round-trips ciphertext and refuses when locked', () => {
    const v = new Vault();
    v.initialize('correct horse battery staple');
    const blob = v.encrypt('access-production-1234-abcd');
    expect(blob).not.toContain('access-production');
    expect(v.decrypt(blob)).toBe('access-production-1234-abcd');

    v.lock();
    expect(() => v.encrypt('x')).toThrow(/locked/);
    expect(() => v.decrypt(blob)).toThrow(/locked/);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const v = new Vault();
    v.initialize('correct horse battery staple');
    expect(v.encrypt('same')).not.toBe(v.encrypt('same'));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const v = new Vault();
    v.initialize('correct horse battery staple');
    const blob = v.encrypt('secret');
    const parts = blob.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => v.decrypt(parts.join(':'))).toThrow();
  });
});
