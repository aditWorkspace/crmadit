import crypto from 'crypto';

/** Hash a 4-digit PIN using scrypt. Safe to store in DB. */
export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** Verify a plain PIN against a stored hash. Timing-safe. */
export function verifyPin(pin: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
