/** PI-12: require an explicit opt-in for pnpm-lock.yaml changes. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeExec } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function collectChangedFiles(args: string[], changed: Set<string>): void {
  try {
    for (const file of safeExec('git', args)
      .split(/\r?\n/u)
      .map((entry) => entry.trim())) {
      if (file) changed.add(file);
    }
  } catch {
    // A missing remote/base is handled conservatively by the local diff below.
  }
}

export interface LockfileCommitGateResult {
  changedFiles: string[];
  evidenceRef?: string;
  hasReviewEvidence: boolean;
  permitted: boolean;
}

export function isLockfileChangePermitted(input: {
  lockfileChanged: boolean;
  allowOverride: boolean;
  hasReviewEvidence: boolean;
}): boolean {
  return !input.lockfileChanged || (input.allowOverride && input.hasReviewEvidence);
}

export function checkLockfileCommitGate(): LockfileCommitGateResult {
  const baseRef = getRegisteredEnvText('GITHUB_BASE_REF')?.trim();
  const safeBase = baseRef && /^[A-Za-z0-9._/-]+$/u.test(baseRef) ? baseRef : undefined;
  const changed = new Set<string>();

  collectChangedFiles(['diff', '--name-only', '--', 'pnpm-lock.yaml'], changed);
  if (safeBase) {
    collectChangedFiles(
      ['diff', '--name-only', `${safeBase}...HEAD`, '--', 'pnpm-lock.yaml'],
      changed
    );
  }

  const evidenceRef = getRegisteredEnvText('PI_LOCKFILE_REVIEW_EVIDENCE')?.trim() || undefined;
  const evidencePath = evidenceRef
    ? path.isAbsolute(evidenceRef)
      ? evidenceRef
      : pathResolver.rootResolve(evidenceRef)
    : undefined;
  const lockfileHash = createHash('sha256')
    .update(readTextFile(pathResolver.rootResolve('pnpm-lock.yaml')))
    .digest('hex');
  const evidenceText =
    evidencePath && safeExistsSync(evidencePath) ? readTextFile(evidencePath) : '';
  const evidenceHash = /pnpm-lock\.yaml`?\s+sha256:\s*([a-f0-9]{64})/iu.exec(evidenceText)?.[1];
  const hasReviewEvidence = Boolean(
    evidencePath && evidenceText.trim() && evidenceHash === lockfileHash
  );
  const lockfileChanged = changed.has('pnpm-lock.yaml');
  const permitted = isLockfileChangePermitted({
    lockfileChanged,
    allowOverride: getRegisteredEnvText('PI_ALLOW_LOCKFILE_CHANGE') === '1',
    hasReviewEvidence,
  });

  return {
    changedFiles: [...changed].sort(),
    evidenceRef,
    hasReviewEvidence,
    permitted,
  };
}

export const runCheckLockfileCommitGate = defineScript({
  name: 'check:lockfile-commit-gate',
  flags: [],
  run(context) {
    const result = checkLockfileCommitGate();
    if (!result.permitted) {
      context.print(
        '[check:lockfile-commit-gate] FAILED: pnpm-lock.yaml changed; set PI_ALLOW_LOCKFILE_CHANGE=1 and PI_LOCKFILE_REVIEW_EVIDENCE to a non-empty reviewed file.'
      );
      throw new ScriptExitError(1);
    }
    context.print(
      `[check:lockfile-commit-gate] OK${result.changedFiles.includes('pnpm-lock.yaml') ? ` (review evidence: ${result.evidenceRef})` : ''}`
    );
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_lockfile_commit_gate.ts') ||
  isDirectScript(import.meta.url, 'check_lockfile_commit_gate.js')
)
  void runCheckLockfileCommitGate();
