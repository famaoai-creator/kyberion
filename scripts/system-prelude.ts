/**
 * scripts/system-prelude.ts
 * Sovereign Prelude: Initializes critical security environment.
 * [SECRET-GUARD COMPLIANT VERSION]
 */

import { secretGuard, logger } from '@agent/core';

export { secretGuard, logger };

export async function main() {
  logger.info('🛡️ Initializing Sovereign System Prelude...');

  // Use Secret Guard for Sudo Key acquisition
  const SUDO_KEY = secretGuard.getSecret('KYBERION_SUDO_KEY') || 'SOVEREIGN_BYPASS_' + Date.now();
  
  // Note: We still set it to process.env for downstream legacy script compatibility
  // but the source of truth is now the Secret Guard.
  process.env.KYBERION_SUDO_KEY = SUDO_KEY;

  logger.success('✅ System Prelude complete.');
}

void main().catch(err => {
  console.error(err);
  process.exit(1);
});
