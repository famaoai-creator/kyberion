import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as pathResolver from '@agent/core/path-resolver';

export interface RefinementResult {
  target: string;
  backup: string;
  branch: string;
  reason: string;
}

export async function refineSelf(target: string, reason: string): Promise<RefinementResult> {
  const rootDir = pathResolver.rootDir();
  const targetFile = path.resolve(rootDir, target);
  const backupDir = pathResolver.shared('archive/backups');

  if (!fs.existsSync(targetFile)) {
    throw new Error(`Target file ${target} not found.`);
  }

  // 1. Mandatory Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${path.basename(target)}.${timestamp}.bak`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(targetFile, backupPath);

  // 2. Propose refinement via PR
  const branchName = `feat/self-refinement-${timestamp.substring(0, 10)}`;

  try {
    // In a test environment, git might not be available or initialized
    execSync(`git checkout -b ${branchName}`, { cwd: rootDir, stdio: 'ignore' });
  } catch (_e) {
    // ignore git errors in simulation/test
  }

  return {
    target,
    backup: backupPath,
    branch: branchName,
    reason,
  };
}
