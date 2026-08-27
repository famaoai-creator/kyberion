/**
 * scripts/refactor/mission-seal.ts
 * Cryptographic sealing (AES+RSA) of mission archives.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { findMissionPath } from './path-resolver.js';
import {
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
export function missionSealArchiveDir(missionId: string): string {
  const configPath = pathResolver.knowledge('product/governance/mission-management-config.json');
  let archiveSubPath = 'active/archive/missions';
  if (safeExistsSync(configPath)) {
    try {
      const config = readJson<{ directories?: { archive?: string } }>(configPath);
      archiveSubPath = config.directories?.archive || archiveSubPath;
    } catch (_) {
      /* fall back to the default archive dir */
    }
  }
  return path.join(pathResolver.rootResolve(archiveSubPath), missionId, 'seal');
}

export async function sealMission(id: string): Promise<string | undefined> {
  const upperId = id.toUpperCase();
  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;

  const pubKeyPath = pathResolver.vault('keys/sovereign-public.pem');
  if (!safeExistsSync(pubKeyPath)) {
    logger.warn('⚠️ [SovereignSeal] Public key not found. Skipping encryption.');
    return;
  }

  logger.info(`🔒 [SovereignSeal] Encrypting mission ${upperId} for archival (Hybrid AES+RSA)...`);

  const archivePath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.tar.gz`);
  const symKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key`);
  if (!safeExistsSync(path.dirname(archivePath))) {
    safeMkdir(path.dirname(archivePath), { recursive: true });
  }
  const sealDir = path.join(missionDir, 'seal');
  const encKeyPath = path.join(sealDir, `${upperId}.key.enc`);
  const encryptedPath = path.join(sealDir, `${upperId}.enc`);

  try {
    // A re-seal replaces the previous seal, and the tarball is taken before
    // seal/ is (re)created so the sealed archive never contains a seal.
    if (safeExistsSync(sealDir)) safeRmSync(sealDir, { recursive: true, force: true });
    safeExec('tar', [
      '-czf',
      archivePath,
      '-C',
      path.dirname(missionDir),
      path.basename(missionDir),
    ]);
    if (!safeExistsSync(sealDir)) safeMkdir(sealDir, { recursive: true });
    safeExec('openssl', ['rand', '-out', symKeyPath, '32']);
    safeExec('openssl', [
      'enc',
      '-aes-256-cbc',
      '-salt',
      '-in',
      archivePath,
      '-out',
      encryptedPath,
      '-pass',
      `file:${symKeyPath}`,
      '-pbkdf2',
    ]);
    safeExec('openssl', [
      'rsautl',
      '-encrypt',
      '-pubin',
      '-inkey',
      pubKeyPath,
      '-in',
      symKeyPath,
      '-out',
      encKeyPath,
    ]);

    logger.success(
      `✅ Mission ${upperId} sealed cryptographically (Encrypted key: ${path.basename(encKeyPath)}).`
    );

    const { createHash } = await import('node:crypto');
    const fileBuffer = safeReadFile(encryptedPath, { encoding: null }) as Buffer;
    const hash = createHash('sha256').update(fileBuffer).digest('hex');

    const anchorInput = pathResolver.sharedTmp(
      `missions/${upperId}/anchor-${upperId}-${Date.now()}.json`
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

    safeUnlinkSync(archivePath);
    safeUnlinkSync(symKeyPath);

    return encryptedPath;
  } catch (err: any) {
    logger.error(`Sealing failed: ${err.message}`);
  }
}
