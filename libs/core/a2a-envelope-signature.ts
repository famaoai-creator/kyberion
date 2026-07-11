import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

/**
 * AA-03 Task 1: one signing module for host-internal A2A envelopes.
 *
 * The previous secret was `KYBERION_A2A_SECRET || randomBytes(32)` — with no
 * env set (the normal case) every process signed with a different throwaway
 * key, so cross-process signatures could never verify and the mechanism was
 * decorative. The shared secret now persists under the runtime root (0600,
 * generated once) so all host-local processes sign and verify with the same
 * key. This is a same-host integrity identity only — cross-host / process
 * isolation threat models are E4's public-key work (this module is shaped so
 * an ed25519 provider can slot in beside hmac-sha256).
 */

export type A2ASignatureAlgorithm = 'hmac-sha256';
export type A2ASignatureMode = 'warn' | 'enforce';

const SECRET_RELATIVE_PATH = 'active/shared/runtime/agent-supervisor/a2a-secret';

let cachedSecret: string | null = null;

/** Test hook: forget the cached secret so key-resolution paths can be exercised. */
export function resetA2ASecretCache(): void {
  cachedSecret = null;
}

export function resolveA2ASecret(): string {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.KYBERION_A2A_SECRET?.trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const secretPath = pathResolver.rootResolve(SECRET_RELATIVE_PATH);
  try {
    if (safeExistsSync(secretPath)) {
      const persisted = String(safeReadFile(secretPath, { encoding: 'utf8' }) || '').trim();
      if (persisted) {
        cachedSecret = persisted;
        return cachedSecret;
      }
    }
  } catch (err: any) {
    logger.warn(`[a2a-signature] could not read persisted secret: ${err?.message || err}`);
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    safeMkdir(path.dirname(secretPath), { recursive: true });
    safeWriteFile(secretPath, generated, { mode: 0o600 });
    logger.info('[a2a-signature] generated and persisted the shared A2A secret');
  } catch (err: any) {
    // Persist failure degrades to the old process-local behavior; say so
    // loudly because cross-process verification will fail until fixed.
    logger.warn(
      `[a2a-signature] could not persist the shared secret — falling back to a process-local key (cross-process signatures will not verify): ${err?.message || err}`
    );
  }
  cachedSecret = generated;
  return cachedSecret;
}

/** AA-03 Task 2: staged rollout — warn (default) records failures, enforce rejects. */
export function resolveA2ASignatureMode(): A2ASignatureMode {
  return process.env.KYBERION_A2A_SIGNATURE === 'enforce' ? 'enforce' : 'warn';
}

export function signA2AContent(content: string): {
  signature: string;
  sig_alg: A2ASignatureAlgorithm;
} {
  const signature = crypto.createHmac('sha256', resolveA2ASecret()).update(content).digest('hex');
  return { signature, sig_alg: 'hmac-sha256' };
}

export function verifyA2AContent(
  content: string,
  signature: string | undefined
): { valid: boolean; reason?: string } {
  if (!signature) return { valid: false, reason: 'missing signature' };
  const expected = signA2AContent(content).signature;
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
    return valid ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  } catch {
    return { valid: false, reason: 'malformed signature' };
  }
}
