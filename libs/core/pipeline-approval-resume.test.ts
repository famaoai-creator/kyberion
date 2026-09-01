import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadPipelineRunJournal: vi.fn(),
  spawnManagedProcess: vi.fn(),
  rootResolve: vi.fn(() => '/repo/dist/scripts/run_pipeline.js'),
  rootDir: vi.fn(() => '/repo'),
  assertSafeRepositoryPath: vi.fn((value: string) => value),
}));

vi.mock('./managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));
vi.mock('./pipeline-run-journal.js', () => ({
  loadPipelineRunJournal: mocks.loadPipelineRunJournal,
}));
vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: mocks.rootResolve,
    rootDir: mocks.rootDir,
  },
}));
vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
}));

import {
  resetPipelineApprovalResumeState,
  resumePipelineRunAfterApproval,
} from './pipeline-approval-resume.js';
import type { ApprovalRequestRecord } from './approval-store.js';

const record: ApprovalRequestRecord = {
  id: 'approval-1',
  kind: 'mission_gate',
  storageChannel: 'pipeline-approval',
  channel: 'pipeline-approval',
  threadTs: 'approval-step',
  correlationId: 'pipeline:run-1:approval-step',
  requestedBy: 'pipeline:run-1',
  requestedAt: '2026-09-01T00:00:00.000Z',
  status: 'approved',
  title: 'Approve pipeline',
  summary: 'Continue',
  requestedByContext: {
    surface: 'system',
    actorId: 'pipeline:run-1',
    actorRole: 'pipeline',
    stepId: 'approval-step',
    pipelineRunId: 'run-1',
    missionId: 'MSN-1',
  },
};

describe('pipeline approval resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPipelineApprovalResumeState();
    mocks.spawnManagedProcess.mockReturnValue({ child: { once: vi.fn() } });
    mocks.loadPipelineRunJournal.mockReturnValue({
      run_id: 'run-1',
      path: '/repo/active/missions/public/MSN-1/coordination/pipeline-runs/run-1.jsonl',
      events: [],
      started: {
        pipeline_id: 'pipeline-1',
        input_path: 'pipelines/test.json',
        mission_id: 'MSN-1',
        step_ids: ['approval-step'],
      },
      completed_nodes: new Map(),
      suspended: {
        step_id: 'approval-step',
        approval_request_id: 'approval-1',
        storage_channel: 'pipeline-approval',
        on_timeout: 'abort',
      },
    });
  });

  it('starts the canonical runner only for the exact suspended approval', () => {
    expect(resumePipelineRunAfterApproval(record)).toMatchObject({
      status: 'started',
      runId: 'run-1',
      resourceId: 'pipeline-run-resume:run-1',
    });
    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'pipeline-run-resume:run-1',
        ownerId: 'MSN-1',
        command: process.execPath,
        args: ['/repo/dist/scripts/run_pipeline.js', '--resume', 'run-1'],
        metadata: expect.objectContaining({
          approvalRequestId: 'approval-1',
          missionId: 'MSN-1',
          stepId: 'approval-step',
        }),
      })
    );
  });

  it('does not launch when the approval is bound to another suspended step', () => {
    const mismatched = {
      ...record,
      requestedByContext: { ...record.requestedByContext, stepId: 'other-step' },
    };
    expect(resumePipelineRunAfterApproval(mismatched)).toMatchObject({
      status: 'not_applicable',
      reason: 'approval step does not match suspended step',
    });
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('does not launch a run whose journal is already finished', () => {
    mocks.loadPipelineRunJournal.mockReturnValue({
      run_id: 'run-1',
      path: '/repo/run-1.jsonl',
      events: [],
      completed_nodes: new Map(),
      finished: { status: 'succeeded' },
    });
    expect(resumePipelineRunAfterApproval(record)).toMatchObject({
      status: 'not_applicable',
      reason: 'pipeline run is already finished',
    });
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });
});
