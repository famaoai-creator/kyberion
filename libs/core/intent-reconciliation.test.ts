import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { reconcileCompletion } from './intent-reconciliation.js';

describe('intent reconciliation', () => {
  const tmpDir = pathResolver.sharedTmp('intent-reconciliation-tests');

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats matching evidence as satisfied', async () => {
    safeMkdir(tmpDir, { recursive: true });
    const evidencePath = `${tmpDir}/closeout.md`;
    safeWriteFile(evidencePath, '# Closeout\nMission closeout complete.');

    const result = await reconcileCompletion({
      goal: {
        summary: 'Mission closeout complete.',
        success_condition: 'The closeout note is saved',
      },
      evidenceRefs: [evidencePath],
    });

    expect(result.satisfied).toBe(true);
    expect(result.delivered).toContain(evidencePath);
    expect(result.gaps).toHaveLength(0);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('surfaces gaps when evidence is missing', async () => {
    const result = await reconcileCompletion({
      goal: {
        summary: 'Deliver a closeout note',
        success_condition: 'The closeout note is saved',
      },
      evidenceRefs: [],
    });

    expect(result.satisfied).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('does not satisfy on single-token overlap alone', async () => {
    const evidencePath = `${tmpDir}/token-overlap.md`;
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(evidencePath, 'report');

    const result = await reconcileCompletion({
      goal: {
        summary: 'Deliver a closeout note',
        success_condition: 'The report file is saved',
      },
      evidenceRefs: [evidencePath],
    });

    expect(result.satisfied).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('does not use evidence reached through a symbolic link', async () => {
    safeMkdir(tmpDir, { recursive: true });
    const target = `${tmpDir}/evidence-target.md`;
    const link = `${tmpDir}/evidence-link.md`;
    safeWriteFile(target, 'The closeout note is saved');
    fs.symlinkSync(target, link);

    const result = await reconcileCompletion({
      goal: {
        summary: 'Deliver a closeout note',
        success_condition: 'The closeout note is saved',
      },
      evidenceRefs: [link],
    });

    expect(result.satisfied).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('does not treat a directory or path name as completion evidence', async () => {
    safeMkdir(tmpDir, { recursive: true });
    const directoryPath = `${tmpDir}/evidence-directory.md`;
    safeMkdir(directoryPath, { recursive: true });

    const result = await reconcileCompletion({
      goal: {
        summary: 'evidence-directory.md',
        success_condition: 'evidence-directory.md',
      },
      evidenceRefs: [directoryPath],
    });

    expect(result.satisfied).toBe(false);
    expect(result.gaps).toContain('evidence-directory.md');
  });
});
