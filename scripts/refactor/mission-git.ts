/**
 * scripts/refactor/mission-git.ts
 * Git operation utilities for Mission micro-repositories.
 */

import * as path from 'node:path';
import { safeExec, safeExistsSync, logger } from '@agent/core';

export function getGitHash(cwd: string): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim();
}

export function deriveMissionBranchName(missionId: string): string {
  const normalized = missionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `mission/${normalized || 'unnamed'}`;
}

export function initMissionRepo(missionDir: string, missionId?: string): void {
  if (!safeExistsSync(path.join(missionDir, '.git'))) {
    logger.info(`🌱 Initializing independent Git repo for mission at ${missionDir}...`);
    safeExec('git', ['init'], { cwd: missionDir });
    safeExec('git', ['config', 'user.name', 'Kyberion Sovereign Entity'], { cwd: missionDir });
    safeExec('git', ['config', 'user.email', 'sovereign@kyberion.local'], { cwd: missionDir });
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', 'chore: initial mission state'], { cwd: missionDir });
    safeExec('git', ['branch', '-m', deriveMissionBranchName(missionId || path.basename(missionDir))], { cwd: missionDir });
  }
}

export function getCurrentBranch(cwd: string): string {
  try {
    return safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
  } catch (_) {
    return 'detached';
  }
}
