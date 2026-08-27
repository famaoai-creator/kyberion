/** PI-12: require an explicit opt-in for pnpm-lock.yaml changes. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeExec } from '../libs/core/secure-io.js';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

const baseRef = process.env.GITHUB_BASE_REF?.trim();
const safeBase = baseRef && /^[A-Za-z0-9._/-]+$/u.test(baseRef) ? baseRef : undefined;
const changed = new Set<string>();

function collect(args: string[]): void {
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

collect(['diff', '--name-only', '--', 'pnpm-lock.yaml']);
if (safeBase) collect(['diff', '--name-only', `${safeBase}...HEAD`, '--', 'pnpm-lock.yaml']);

const evidenceRef = process.env.PI_LOCKFILE_REVIEW_EVIDENCE?.trim();
const evidencePath = evidenceRef
  ? path.isAbsolute(evidenceRef)
    ? evidenceRef
    : pathResolver.rootResolve(evidenceRef)
  : undefined;
const lockfileHash = createHash('sha256')
  .update(safeReadFile(pathResolver.rootResolve('pnpm-lock.yaml')))
  .digest('hex');
const evidenceText =
  evidencePath && safeExistsSync(evidencePath)
    ? String(safeReadFile(evidencePath, { encoding: 'utf8' }))
    : '';
const evidenceHash = /pnpm-lock\.yaml`?\s+sha256:\s*([a-f0-9]{64})/iu.exec(evidenceText)?.[1];
const hasReviewEvidence = Boolean(
  evidencePath && evidenceText.trim() && evidenceHash === lockfileHash
);

if (
  changed.has('pnpm-lock.yaml') &&
  (process.env.PI_ALLOW_LOCKFILE_CHANGE !== '1' || !hasReviewEvidence)
) {
  console.error(
    '[check:lockfile-commit-gate] FAILED: pnpm-lock.yaml changed; set PI_ALLOW_LOCKFILE_CHANGE=1 and PI_LOCKFILE_REVIEW_EVIDENCE to a non-empty reviewed file.'
  );
  process.exitCode = 1;
} else {
  console.log(
    `[check:lockfile-commit-gate] OK${changed.has('pnpm-lock.yaml') ? ` (review evidence: ${evidenceRef})` : ''}`
  );
}
