/**
 * secret-encryption.ts — AC-05 Task 2: opt-in at-rest encryption for
 * connection documents.
 *
 * Mode is selected via KYBERION_SECRET_ENCRYPTION:
 *   none      (default) — current plaintext behaviour, fully compatible
 *   keychain  — AES-256-GCM with a 32-byte key held in the macOS keychain
 *               (generic password; created on first use)
 *
 * Reads auto-detect the format: plaintext documents keep loading after the
 * mode is enabled, and `pnpm secrets:encrypt` migrates them in bulk (with
 * `--decrypt` as the export escape hatch the plan's key-loss note requires).
 * An unknown mode value throws — an operator who asked for encryption must
 * never silently get plaintext.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { safeExecResult } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { memoizedKeychainRead } from '../foundation/secret-resolution-session.js';

export type SecretEncryptionMode = 'none' | 'keychain';

const MODE_ENV = 'KYBERION_SECRET_ENCRYPTION';
const ENVELOPE_MARKER = 'kyberion-encrypted';
const ENVELOPE_VERSION = 1;
const KEYCHAIN_SERVICE = 'kyberion-secret-guard';
const KEYCHAIN_ACCOUNT = 'connection-encryption-key';

export interface EncryptedConnectionEnvelope {
  __kyberion__: typeof ENVELOPE_MARKER;
  version: number;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export function resolveSecretEncryptionMode(
  env: Record<string, string | undefined> = process.env
): SecretEncryptionMode {
  const raw = String(env[MODE_ENV] || 'none')
    .trim()
    .toLowerCase();
  if (raw === '' || raw === 'none') return 'none';
  if (raw === 'keychain') return 'keychain';
  throw new Error(
    `[secret-encryption] unsupported ${MODE_ENV}='${raw}' — refusing to guess ` +
      "(supported: 'none', 'keychain'); fix the value rather than risk plaintext writes"
  );
}

export function isEncryptedConnectionEnvelope(
  value: unknown
): value is EncryptedConnectionEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).__kyberion__ === ENVELOPE_MARKER &&
    typeof (value as Record<string, unknown>).ciphertext === 'string'
  );
}

// ─── Key management ──────────────────────────────────────────────────────────

let cachedKey: Buffer | null = null;
let testKeyOverride: Buffer | null = null;

/** Test hook: inject a fixed key instead of touching the OS keychain. */
export function overrideSecretEncryptionKeyForTests(key: Buffer | null): void {
  testKeyOverride = key;
  cachedKey = null;
}

function keychainRead(): { key: Buffer | null; missing: boolean } {
  let missing = false;
  const hex = memoizedKeychainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, () => {
    const result = safeExecResult(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeoutMs: 10_000, maxOutputMB: 1 }
    );
    // security's exit status for errSecItemNotFound (-25300) is 44. Refusal,
    // cancellation, locked keychains and timeouts never authorize creation.
    missing = result.status === 44;
    if (result.status !== 0) return null;
    const value = String(result.stdout || '').trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  });
  return { key: hex ? Buffer.from(hex, 'hex') : null, missing };
}

function keychainCreate(): Buffer {
  const key = randomBytes(32);
  const script = [
    'import Foundation',
    'import Security',
    'guard let service = readLine(), let account = readLine(), let password = readLine(), let data = password.data(using: .utf8) else { exit(2) }',
    'let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecValueData as String: data]',
    'let status = SecItemAdd(query as CFDictionary, nil)',
    'exit(status == errSecSuccess ? 0 : Int32(status))',
  ].join('\n');
  const result = safeExecResult('swift', ['-e', script], {
    input: `${KEYCHAIN_SERVICE}\n${KEYCHAIN_ACCOUNT}\n${key.toString('hex')}\n`,
    timeoutMs: 60_000,
    maxOutputMB: 1,
  });
  if (result.status !== 0) {
    throw new Error(
      `[secret-encryption] failed to store the encryption key in the keychain: ${result.stderr || result.status}`
    );
  }
  return key;
}

function getEncryptionKey(createIfMissing = false): Buffer {
  if (testKeyOverride) return testKeyOverride;
  if (cachedKey) return cachedKey;
  if (process.platform !== 'darwin') {
    throw new Error(
      "[secret-encryption] mode 'keychain' requires macOS (the `security` CLI); " +
        'use none on this host or wait for the age-based mode'
    );
  }
  const read = keychainRead();
  if (!read.key && !(createIfMissing && read.missing))
    throw new Error(
      '[secret-encryption] Encryption key unavailable; access was refused, timed out, or the key is missing. No replacement key was created.'
    );
  cachedKey = read.key ?? keychainCreate();
  return cachedKey;
}

// ─── Envelope codec ──────────────────────────────────────────────────────────

export function encryptConnectionDocument(
  document: Record<string, unknown>
): EncryptedConnectionEnvelope {
  const key = getEncryptionKey(true);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(document), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    __kyberion__: ENVELOPE_MARKER,
    version: ENVELOPE_VERSION,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptConnectionDocument(
  envelope: EncryptedConnectionEnvelope
): Record<string, unknown> {
  if (envelope.algorithm !== 'aes-256-gcm') {
    throw new Error(`[secret-encryption] unsupported algorithm '${envelope.algorithm}'`);
  }
  const key = getEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return parseSafeJsonInput(plaintext.toString('utf8'), 'decrypted secret document') as Record<
    string,
    unknown
  >;
}
