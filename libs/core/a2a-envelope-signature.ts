import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Test hook: forget the cached secret so key-resolution paths can be exercised. */
export function _resetA2ASecretCacheForTests(): void {
  cachedSecret = null;
}

export function resolveA2ASecret(): string {
  if (cachedSecret) return cachedSecret;

  const fromEnv = getRegisteredEnvText('KYBERION_A2A_SECRET')?.trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const secretPath = assertSafeRepositoryPath(pathResolver.rootResolve(SECRET_RELATIVE_PATH), {
    allowMissingLeaf: true,
  });
  try {
    if (safeExistsSync(secretPath)) {
      if (!safeLstat(secretPath).isFile()) {
        throw new Error(
          `[A2A_SECRET_RESOURCE] persisted secret must be a regular file: ${secretPath}`
        );
      }
      const persisted = String(safeReadFile(secretPath, { encoding: 'utf8' }) || '').trim();
      if (persisted) {
        cachedSecret = persisted;
        return cachedSecret;
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('[A2A_SECRET_RESOURCE]')) throw err;
    logger.warn(`[a2a-signature] could not read persisted secret: ${errorMessage(err)}`);
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    safeMkdir(path.dirname(secretPath), { recursive: true });
    safeWriteFile(secretPath, generated, { mode: 0o600 });
    logger.info('[a2a-signature] generated and persisted the shared A2A secret');
  } catch (err: unknown) {
    // Persist failure degrades to the old process-local behavior; say so
    // loudly because cross-process verification will fail until fixed.
    logger.warn(
      `[a2a-signature] could not persist the shared secret — falling back to a process-local key (cross-process signatures will not verify): ${errorMessage(err)}`
    );
  }
  cachedSecret = generated;
  return cachedSecret;
}

/** AA-03 Task 2: staged rollout — warn (default) records failures, enforce rejects. */
export function resolveA2ASignatureMode(): A2ASignatureMode {
  return getRegisteredEnvText('KYBERION_A2A_SIGNATURE') === 'enforce' ? 'enforce' : 'warn';
}

/**
 * NI-02: canonical signed-content serialization for an A2A envelope.
 *
 * The signed content is the JSON of `{ header, payload }` with the
 * signature-carrying fields (`signature`, `sig_alg`) blanked — exactly the
 * shape a2a-bridge has always signed. Because the WHOLE header is spread
 * into the canonical form, every header claim — including NI-02's
 * `sender_nhi_id` — is inside the HMAC: altering or stripping a present
 * claim breaks verification. Backward compatible by construction:
 * `JSON.stringify` drops `undefined` properties, so an envelope without
 * `sender_nhi_id` canonicalizes byte-for-byte as it did before the field
 * existed, and previously signed traffic still verifies.
 */
export function canonicalA2AEnvelopeContent(envelope: {
  header: object;
  payload: unknown;
}): string {
  return JSON.stringify({
    header: {
      ...(envelope.header as Record<string, unknown>),
      signature: undefined,
      sig_alg: undefined,
    },
    payload: envelope.payload,
  });
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
