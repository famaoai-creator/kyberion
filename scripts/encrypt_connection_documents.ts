/**
 * encrypt_connection_documents.ts — AC-05 Task 2 migration CLI.
 *
 * Encrypts (or, with --decrypt, exports back to plaintext) every connection
 * document under knowledge/personal/connections/. Each file gets a raw-byte
 * .bak before it is rewritten — the plan's key-loss note requires both the
 * backup and the plaintext escape hatch.
 *
 * Usage:
 *   KYBERION_SECRET_ENCRYPTION=keychain pnpm secrets:encrypt            # encrypt all
 *   KYBERION_SECRET_ENCRYPTION=keychain pnpm secrets:encrypt --decrypt  # export plaintext
 */

import * as path from 'node:path';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
  resolveSecretEncryptionMode,
} from '@agent/core/secret-encryption';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/governance';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function migrateConnectionDocuments(input: { decrypt: boolean; connectionsDir?: string }): {
  encrypted: number;
  decrypted: number;
  skipped: number;
} {
  const dir = input.connectionsDir ?? pathResolver.resolve('knowledge/personal/connections');
  const counts = { encrypted: 0, decrypted: 0, skipped: 0 };
  if (!safeExistsSync(dir)) return counts;

  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.json') || entry.endsWith('.bak')) continue;
    const filePath = path.join(dir, entry);
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(raw, `connection document ${entry}`);
    } catch {
      counts.skipped += 1;
      continue;
    }

    const encrypted = isEncryptedConnectionEnvelope(parsed);
    if (input.decrypt && !encrypted) {
      counts.skipped += 1;
      continue;
    }
    if (!input.decrypt && encrypted) {
      counts.skipped += 1;
      continue;
    }

    safeWriteFile(`${filePath}.bak`, raw);
    if (input.decrypt) {
      const document = decryptConnectionDocument(parsed as never);
      safeWriteFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
      counts.decrypted += 1;
    } else {
      const envelope = encryptConnectionDocument(parsed as Record<string, unknown>);
      safeWriteFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
      counts.encrypted += 1;
    }
  }
  return counts;
}

async function main(argv: string[] = []): Promise<number> {
  const decrypt = argv.includes('--decrypt');
  if (!decrypt && resolveSecretEncryptionMode() === 'none') {
    logger.error(
      '[secrets:encrypt] KYBERION_SECRET_ENCRYPTION is not set — refusing to encrypt ' +
        'without an explicitly configured mode (set keychain).'
    );
    return 1;
  }
  const counts = withExecutionContext('sovereign_concierge', () =>
    migrateConnectionDocuments({ decrypt })
  );
  logger.success(
    `[secrets:encrypt] encrypted=${counts.encrypted} decrypted=${counts.decrypted} skipped=${counts.skipped} (raw .bak written per changed file)`
  );
  return 0;
}

export const runEncryptConnectionDocuments = defineScript({
  name: 'secrets:encrypt',
  flags: [],
  run: async ({ argv }) => {
    try {
      const code = await main(argv);
      if (code !== 0) throw new ScriptExitError(code, '', true);
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      throw new ScriptExitError(
        1,
        `[secrets:encrypt] failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

if (
  isDirectScript(import.meta.url, 'encrypt_connection_documents.ts') ||
  isDirectScript(import.meta.url, 'encrypt_connection_documents.js')
)
  void runEncryptConnectionDocuments();
