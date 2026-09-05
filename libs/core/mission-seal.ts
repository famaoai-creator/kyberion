/**
 * scripts/refactor/mission-seal.ts
 * Cryptographic sealing (AES+RSA) of mission archives.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { loadMissionManagementConfig } from './mission-management-config.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

/**
 * AL-02: sealed outputs are durable archive artifacts, not consumables. They
 * are written to `<missionDir>/seal/` (after the tarball is taken, so the
 * seal never contains itself); the finish-flow archive step (`cp -r` of the
 * mission tree into the archive area declared by mission-management-config
 * `directories.archive`, default `active/archive/missions`) then lands them
 * at `<archive>/<MISSION_ID>/seal/` — this final location is what
 * `missionSealArchiveDir` resolves. Writing straight into the archive area
 * would not survive: finishMission `rm -rf`s `<archive>/<MISSION_ID>` before
 * copying the mission tree. Only intermediates (tarball, symmetric key,
 * anchor input) still pass through `active/shared/tmp/` and are removed
 * before returning.
 */
function assertMissionIdPathSegment(missionId: string): string {
  const normalized = String(missionId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error('[MISSION_SEAL_SCOPE] mission id must be a single path segment');
  }
  return normalized;
}

export function missionSealArchiveDir(missionId: string): string {
  const safeMissionId = assertMissionIdPathSegment(missionId);
  let archiveSubPath = 'active/archive/missions';
  const config = loadMissionManagementConfig();
  archiveSubPath = config?.directories.archive || archiveSubPath;
  return assertSafeRepositoryPath(
    path.join(pathResolver.rootResolve(archiveSubPath), safeMissionId, 'seal'),
    { allowMissingLeaf: true }
  );
}

export async function sealMission(id: string): Promise<string | undefined> {
  const upperId = assertMissionIdPathSegment(id.toUpperCase());
  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;
  try {
    assertSafeRepositoryPath(missionDir);
  } catch (error: any) {
    logger.error(`Mission ${upperId} path rejected: ${error?.message || String(error)}`);
    return;
  }

  const pubKeyPath = pathResolver.vault('keys/sovereign-public.pem');
  assertSafeRepositoryPath(pubKeyPath, { allowMissingLeaf: true });
  if (!safeExistsSync(pubKeyPath)) {
    logger.warn('⚠️ [SovereignSeal] Public key not found. Skipping encryption.');
    return;
  }

  logger.info(`🔒 [SovereignSeal] Encrypting mission ${upperId} for archival (Hybrid AES+RSA)...`);

  const archivePath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.tar.gz`);
  const symKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key`);
  const safeArchivePath = assertSafeRepositoryPath(archivePath, { allowMissingLeaf: true });
  const safeSymKeyPath = assertSafeRepositoryPath(symKeyPath, { allowMissingLeaf: true });
  const safeArchiveDir = assertSafeRepositoryPath(path.dirname(safeArchivePath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(safeArchiveDir)) {
    safeMkdir(safeArchiveDir, { recursive: true });
  }
  const sealDir = assertSafeRepositoryPath(path.join(missionDir, 'seal'), {
    allowMissingLeaf: true,
  });
  const encKeyPath = assertSafeRepositoryPath(path.join(sealDir, `${upperId}.key.enc`), {
    allowMissingLeaf: true,
  });
  const encryptedPath = assertSafeRepositoryPath(path.join(sealDir, `${upperId}.enc`), {
    allowMissingLeaf: true,
  });

  try {
    // A re-seal replaces the previous seal, and the tarball is taken before
    // seal/ is (re)created so the sealed archive never contains a seal.
    if (safeExistsSync(sealDir)) safeRmSync(sealDir, { recursive: true, force: true });
    safeExec('tar', [
      '-czf',
      safeArchivePath,
      '-C',
      path.dirname(missionDir),
      path.basename(missionDir),
    ]);
    if (!safeExistsSync(sealDir)) safeMkdir(sealDir, { recursive: true });
    safeExec('openssl', ['rand', '-out', safeSymKeyPath, '32']);
    safeExec('openssl', [
      'enc',
      '-aes-256-cbc',
      '-salt',
      '-in',
      safeArchivePath,
      '-out',
      encryptedPath,
      '-pass',
      `file:${safeSymKeyPath}`,
      '-pbkdf2',
    ]);
    safeExec('openssl', [
      'rsautl',
      '-encrypt',
      '-pubin',
      '-inkey',
      pubKeyPath,
      '-in',
      safeSymKeyPath,
      '-out',
      encKeyPath,
    ]);

    logger.success(
      `✅ Mission ${upperId} sealed cryptographically (Encrypted key: ${path.basename(encKeyPath)}).`
    );

    const { createHash } = await import('node:crypto');
    const fileBuffer = safeReadFile(encryptedPath, { encoding: null }) as Buffer;
    const hash = createHash('sha256').update(fileBuffer).digest('hex');

    const anchorInput = assertSafeRepositoryPath(
      pathResolver.sharedTmp(`missions/${upperId}/anchor-${upperId}-${Date.now()}.json`),
      { allowMissingLeaf: true }
    );
    safeWriteFile(
      anchorInput,
      JSON.stringify({
        action: 'anchor_mission',
        params: { mission_id: upperId, hash },
      })
    );

    try {
      safeExec('node', [
        pathResolver.capabilityEntry('blockchain-actuator'),
        '--input',
        anchorInput,
      ]);
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
    safeUnlinkSync(anchorInput);

    safeUnlinkSync(safeArchivePath);
    safeUnlinkSync(safeSymKeyPath);

    return encryptedPath;
  } catch (err: any) {
    logger.error(`Sealing failed: ${err.message}`);
  }
}
