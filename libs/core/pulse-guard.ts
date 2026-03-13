import { createHmac } from 'node:crypto';
import { secretGuard } from './secret-guard.js';

/**
 * Pulse Guard: Ensures Stimuli Integrity via HMAC.
 * [SECRET-GUARD COMPLIANT VERSION]
 */
export const pulseGuard = {
  sign: (payload: string): string => {
    const secret = secretGuard.getSecret('KYBERION_SOVEREIGN_SECRET') || 'default-secret';
    const hmac = createHmac('sha256', secret).update(payload).digest('hex');
    return hmac;
  },

  verify: (payload: string, signature: string): boolean => {
    try {
      const secret = secretGuard.getSecret('KYBERION_SOVEREIGN_SECRET') || 'default-secret';
      const expectedHmac = createHmac('sha256', secret).update(payload).digest('hex');
      return expectedHmac === signature;
    } catch (_) {
      return false;
    }
  }
};
