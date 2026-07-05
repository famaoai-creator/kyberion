import { afterEach, describe, expect, it } from 'vitest';
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
});
