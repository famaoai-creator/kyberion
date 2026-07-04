import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import {
  safeCreateExclusiveFileSync,
  safeChmodSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';

export type ChainAlg = 'sha256' | 'hmac-sha256';

export const GENESIS_HASH = '0'.repeat(64);

export interface ChainHashOptions {
  alg?: ChainAlg;
  key?: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
}

const KEY_FILE = 'runtime/audit/chain-key';

function auditKeyPath(): string {
  const resolver = pathResolver as {
    shared?: (subPath?: string) => string;
    rootDir?: () => string;
  };
  if (typeof resolver.shared === 'function') return resolver.shared(KEY_FILE);
  if (typeof resolver.rootDir === 'function') {
    return path.join(resolver.rootDir(), 'active', 'shared', KEY_FILE);
  }
  return path.join(process.cwd(), 'active', 'shared', KEY_FILE);
}

export function resolveAuditChainKey(options: { createIfMissing?: boolean } = {}): string | null {
  const fromEnv = process.env.KYBERION_AUDIT_CHAIN_KEY?.trim();
  if (fromEnv) return fromEnv;

  const keyPath = auditKeyPath();
  if (safeExistsSync(keyPath)) {
    const existing = String(safeReadFile(keyPath, { encoding: 'utf8' })).trim();
    return existing || null;
  }
  if (!options.createIfMissing) return null;

  const dir = path.dirname(keyPath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const generated = randomBytes(32).toString('hex');
  try {
    safeCreateExclusiveFileSync(keyPath, `${generated}\n`);
    // Restrict access to owner-only (read+write) — key must not be world-readable.
    safeChmodSync(keyPath, 0o600);
  } catch {
    if (safeExistsSync(keyPath)) {
      const existing = String(safeReadFile(keyPath, { encoding: 'utf8' })).trim();
      return existing || null;
    }
    throw new Error('failed_to_create_audit_chain_key');
  }
  return generated;
}

export function getAuditChainKeyId(key = resolveAuditChainKey()): string | undefined {
  if (!key) return undefined;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function digest(payload: string, options: ChainHashOptions): string {
  if ((options.alg ?? 'sha256') === 'hmac-sha256') {
    if (!options.key) throw new Error('missing_audit_chain_key');
    return createHmac('sha256', options.key).update(payload).digest('hex');
  }
  return createHash('sha256').update(payload).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function computeAuditEntryHash(
  entry: Record<string, unknown>,
  previousHash: string,
  options: ChainHashOptions = {}
): string {
  return digest(previousHash + JSON.stringify({ ...entry, currentHash: undefined }), options);
}

export function verifyAuditEntryHash(
  entry: Record<string, unknown>,
  expectedPreviousHash: string,
  options: ChainHashOptions = {}
): ChainVerifyResult {
  if (entry.previousHash !== expectedPreviousHash) {
    return {
      ok: false,
      reason: 'previous_hash_mismatch',
      expectedHash: expectedPreviousHash,
      actualHash: String(entry.previousHash ?? ''),
    };
  }
  try {
    const expectedHash = computeAuditEntryHash(entry, expectedPreviousHash, options);
    const actualHash = String(entry.currentHash ?? '');
    return {
      ok: sameHash(actualHash, expectedHash),
      expectedHash,
      actualHash,
      ...(sameHash(actualHash, expectedHash) ? {} : { reason: 'current_hash_mismatch' }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function computeLedgerEntryHash(
  entryWithoutHash: Record<string, unknown>,
  options: ChainHashOptions = {}
): string {
  return digest(JSON.stringify(entryWithoutHash), options);
}

export function verifyLedgerEntryHash(
  entry: Record<string, unknown>,
  expectedParentHash: string,
  options: ChainHashOptions = {}
): ChainVerifyResult {
  if (entry.parent_hash !== expectedParentHash) {
    return {
      ok: false,
      reason: 'parent_hash_mismatch',
      expectedHash: expectedParentHash,
      actualHash: String(entry.parent_hash ?? ''),
    };
  }
  const { hash, ...dataWithoutHash } = entry;
  try {
    const expectedHash = computeLedgerEntryHash(dataWithoutHash, options);
    const actualHash = String(hash ?? '');
    return {
      ok: sameHash(actualHash, expectedHash),
      expectedHash,
      actualHash,
      ...(sameHash(actualHash, expectedHash) ? {} : { reason: 'hash_mismatch' }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
