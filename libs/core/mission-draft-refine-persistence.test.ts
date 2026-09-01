import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nodePath from 'node:path';
import { withExecutionContext, withExecutionContextAsync } from './authority.js';
import { missionDir } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const draftRefineMock = vi.hoisted(() => ({ draftRefine: vi.fn() }));
vi.mock('./draft-refine.js', () => draftRefineMock);

import { applyDraftRefineToDeliverable } from './mission-orchestration-worker-part-results.js';

const missionId = `MSN-DRAFT-REFINE-${process.pid}`;
const missionPath = missionDir(missionId, 'public');

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(missionPath, { recursive: true, force: true });
  });
  draftRefineMock.draftRefine.mockReset();
});

describe('applyDraftRefineToDeliverable', () => {
  it('records a provisioned receipt and verifies the refined native text', async () => {
    const filePath = nodePath.join(missionPath, 'evidence', 'report.md');
    await withExecutionContextAsync('mission_controller', async () => {
      safeMkdir(nodePath.dirname(filePath), { recursive: true });
      safeWriteFile(filePath, '# Original\n');
      draftRefineMock.draftRefine.mockResolvedValue({
        content: '# Refined\n',
        passes: 1,
        improved: true,
        initial_severity: 'warn',
        final_severity: 'ok',
        history: [],
      });
      await applyDraftRefineToDeliverable({
        missionId,
        task: { task_id: 'TASK-REFINE', deliverable: 'evidence/report.md' } as never,
        teamRole: 'implementer',
      });
    });

    expect(String(safeReadFile(filePath, { encoding: 'utf8' }))).toBe('# Refined\n');
    const receiptPath = nodePath.join(missionPath, 'coordination', 'provisioned-entries.jsonl');
    const phases = String(safeReadFile(receiptPath, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { phase: string }).phase);
    expect(phases).toEqual(['provisioned', 'verified']);
  });

  it('does not refine an absolute deliverable outside the mission path', async () => {
    const outsidePath = nodePath.join(missionPath, '..', `draft-refine-outside-${process.pid}.md`);
    await withExecutionContextAsync('mission_controller', async () => {
      safeWriteFile(outsidePath, '# Original\n');
      draftRefineMock.draftRefine.mockResolvedValue({
        content: '# Refined\n',
        passes: 1,
        improved: true,
        initial_severity: 'warn',
        final_severity: 'ok',
        history: [],
      });
      await applyDraftRefineToDeliverable({
        missionId,
        task: { task_id: 'TASK-REFINE-OUTSIDE', deliverable: outsidePath } as never,
        teamRole: 'implementer',
      });
    });
    expect(String(safeReadFile(outsidePath, { encoding: 'utf8' }))).toBe('# Original\n');
    withExecutionContext('mission_controller', () => safeRmSync(outsidePath, { force: true }));
  });
});
