/**
 * scripts/refactor/mission-seal.ts
 * Cryptographic sealing (AES+RSA) of mission archives.
 */

import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeExec,
  safeExistsSync,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core';

export async function sealMission(id: string): Promise<string | undefined> {
  const upperId = id.toUpperCase();
  const missionDir = (await import('@agent/core')).findMissionPath(upperId);
  if (!missionDir) return;

  const pubKeyPath = pathResolver.vault('keys/sovereign-public.pem');
  if (!safeExistsSync(pubKeyPath)) {
    logger.warn('⚠️ [SovereignSeal] Public key not found. Skipping encryption.');
    return;
  }

  logger.info(`🔒 [SovereignSeal] Encrypting mission ${upperId} for archival (Hybrid AES+RSA)...`);

  const archivePath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.tar.gz`);
  const symKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key`);
  const encKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key.enc`);
  const encryptedPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.enc`);

  try {
    safeExec('tar', ['-czf', archivePath, '-C', path.dirname(missionDir), path.basename(missionDir)]);
    safeExec('openssl', ['rand', '-out', symKeyPath, '32']);
    safeExec('openssl', ['enc', '-aes-256-cbc', '-salt', '-in', archivePath, '-out', encryptedPath, '-pass', `file:${symKeyPath}`, '-pbkdf2']);
    safeExec('openssl', ['rsautl', '-encrypt', '-pubin', '-inkey', pubKeyPath, '-in', symKeyPath, '-out', encKeyPath]);

    logger.success(`✅ Mission ${upperId} sealed cryptographically (Encrypted key: ${path.basename(encKeyPath)}).`);

    const { createHash } = await import('node:crypto');
    const fileBuffer = safeReadFile(encryptedPath, { encoding: null }) as Buffer;
    const hash = createHash('sha256').update(fileBuffer).digest('hex');

    const anchorInput = pathResolver.sharedTmp(`missions/${upperId}/anchor-${upperId}-${Date.now()}.json`);
    safeWriteFile(anchorInput, JSON.stringify({
      action: 'anchor_mission',
      params: { mission_id: upperId, hash }
    }));

    try {
      safeExec('node', [pathResolver.capabilityEntry('blockchain-actuator'), '--input', anchorInput]);
    } catch (_) {}
    safeUnlinkSync(anchorInput);

    safeUnlinkSync(archivePath);
    safeUnlinkSync(symKeyPath);

    return encryptedPath;
  } catch (err: any) {
    logger.error(`Sealing failed: ${err.message}`);
  }
}
