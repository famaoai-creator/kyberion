import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readTextFile } from '@agent/core/foundation';
import {
  isEncryptedConnectionEnvelope,
  overrideSecretEncryptionKeyForTests,
} from '@agent/core/secret-encryption';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  safeExistsSync,
} from '@agent/core/secure-io';
import {
  migrateConnectionDocuments,
  readConnectionDocumentTextFile,
} from './encrypt_connection_documents.js';

let dir: string;

beforeEach(() => {
  overrideSecretEncryptionKeyForTests(randomBytes(32));
  dir = path.join(pathResolver.active('shared/tmp/tests'), `secrets-migrate-${Date.now()}`);
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'github.json'), `${JSON.stringify({ token: 'ghp_abc' })}\n`);
});

afterEach(() => {
  overrideSecretEncryptionKeyForTests(null);
  safeRmSync(dir, { recursive: true, force: true });
});

describe('migrateConnectionDocuments (AC-05)', () => {
  it('uses the foundation reader for plaintext connection documents', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/encrypt_connection_documents.ts')
    );
    expect(source).toContain('parseSafeJsonInput, readTextFile');
    expect(source).toContain('readConnectionDocumentTextFile(filePath: string)');
  });

  it('rejects a directory before reading a connection document', () => {
    expect(() => readConnectionDocumentTextFile(dir)).toThrow('must be a regular file');
  });

  it('encrypts plaintext documents with a raw .bak, then round-trips via --decrypt', () => {
    const first = migrateConnectionDocuments({ decrypt: false, connectionsDir: dir });
    expect(first).toEqual({ encrypted: 1, decrypted: 0, skipped: 0 });

    const encryptedRaw = safeReadFile(path.join(dir, 'github.json'), {
      encoding: 'utf8',
    }) as string;
    expect(encryptedRaw).not.toContain('ghp_abc');
    expect(isEncryptedConnectionEnvelope(JSON.parse(encryptedRaw))).toBe(true);
    expect(safeExistsSync(path.join(dir, 'github.json.bak'))).toBe(true);
    expect(safeReadFile(path.join(dir, 'github.json.bak'), { encoding: 'utf8' })).toContain(
      'ghp_abc'
    );

    // Idempotent: already-encrypted files are skipped.
    expect(migrateConnectionDocuments({ decrypt: false, connectionsDir: dir })).toEqual({
      encrypted: 0,
      decrypted: 0,
      skipped: 1,
    });

    // Escape hatch: --decrypt restores plaintext.
    const exported = migrateConnectionDocuments({ decrypt: true, connectionsDir: dir });
    expect(exported).toEqual({ encrypted: 0, decrypted: 1, skipped: 0 });
    const plain = JSON.parse(
      safeReadFile(path.join(dir, 'github.json'), { encoding: 'utf8' }) as string
    );
    expect(plain).toEqual({ token: 'ghp_abc' });
  });

  it('skips persisted documents containing dangerous JSON keys', () => {
    safeWriteFile(
      path.join(dir, 'unsafe.json'),
      '{"__proto__":{"token":"should-not-be-reencrypted"}}\n'
    );

    expect(migrateConnectionDocuments({ decrypt: false, connectionsDir: dir })).toEqual({
      encrypted: 1,
      decrypted: 0,
      skipped: 1,
    });
    expect(safeExistsSync(path.join(dir, 'unsafe.json.bak'))).toBe(false);
  });
});
