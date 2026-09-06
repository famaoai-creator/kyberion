import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { readComplianceTextFile, runComplianceScan } from './compliance_checker.js';

describe('compliance checker', () => {
  const root = pathResolver.sharedTmp(`compliance-checker-${process.pid}`);

  beforeEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    safeMkdir(root, { recursive: true });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
  });

  it('scans repository files through the production compliance entrypoint', async () => {
    safeWriteFile(path.join(root, 'notes.md'), 'A routine operational note.\n');

    await expect(
      runComplianceScan(['--dir', pathResolver.toRepoRelative(root), '--tier', 'public'])
    ).resolves.toEqual({ status: 'passed', violations: [] });
  });

  it('rejects a directory before reading compliance content', () => {
    expect(() => readComplianceTextFile(root)).toThrow('must be a regular file');
  });
});
