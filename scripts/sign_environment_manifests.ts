/**
 * sign_environment_manifests.ts — SA-02: sign governed environment manifests.
 *
 * Computes the HMAC-SHA256 signature for every manifest under
 * knowledge/product/governance/environment-manifests/ and writes the
 * `signature` field back. Requires KYBERION_MANIFEST_SIGNING_KEY; once every
 * manifest is signed and the key is present at runtime,
 * loadEnvironmentManifest() enforces signatures fail-closed.
 *
 * Usage:
 *   KYBERION_MANIFEST_SIGNING_KEY=... pnpm manifests:sign          # sign all
 *   KYBERION_MANIFEST_SIGNING_KEY=... pnpm manifests:sign --check  # verify only
 */

import * as path from 'node:path';
import {
  computeManifestSignature,
  listEnvironmentManifestIds,
  logger,
  pathResolver,
  safeJsonParse,
  safeReadFile,
  safeWriteFile,
  verifyManifestSignature,
  type EnvironmentManifest,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const MANIFEST_DIR = 'knowledge/product/governance/environment-manifests';

export async function main(argv: string[] = []): Promise<number> {
  const checkOnly = argv.includes('--check');
  const signingKey = getRegisteredEnvText('KYBERION_MANIFEST_SIGNING_KEY');
  if (!signingKey) {
    logger.error(
      '[manifests:sign] KYBERION_MANIFEST_SIGNING_KEY is not set — refusing to sign/verify.'
    );
    return 1;
  }

  const ids = listEnvironmentManifestIds();
  if (ids.length === 0) {
    logger.warn('[manifests:sign] no manifests found');
    return 0;
  }

  let failures = 0;
  withExecutionContext('ecosystem_architect', () => {
    for (const id of ids) {
      const filePath = pathResolver.rootResolve(path.join(MANIFEST_DIR, `${id}.json`));
      const manifest = safeJsonParse<EnvironmentManifest>(
        safeReadFile(filePath, { encoding: 'utf8' }) as string,
        `manifest ${id}`
      );
      if (checkOnly) {
        if (verifyManifestSignature(manifest, signingKey)) {
          logger.info(`[manifests:sign] ${id}: signature ok`);
        } else {
          logger.error(`[manifests:sign] ${id}: signature missing or invalid`);
          failures += 1;
        }
        continue;
      }
      manifest.signature = computeManifestSignature(manifest, signingKey);
      safeWriteFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
      logger.success(`[manifests:sign] signed ${id}`);
    }
  });
  return failures > 0 ? 1 : 0;
}

export const runSignEnvironmentManifests = defineScript({
  name: 'manifests:sign',
  flags: [],
  run: async ({ argv }) => {
    try {
      const code = await main(argv);
      if (code !== 0) throw new ScriptExitError(code, '', true);
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      throw new ScriptExitError(
        1,
        `[manifests:sign] failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

if (
  isDirectScript(import.meta.url, 'sign_environment_manifests.ts') ||
  isDirectScript(import.meta.url, 'sign_environment_manifests.js')
)
  void runSignEnvironmentManifests();
