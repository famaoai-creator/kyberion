import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../authority.js', () => ({
  buildSystemRoleLaunchEnv: (
    base: NodeJS.ProcessEnv,
    systemRole: string,
    options: { missionRole: string; persona: string }
  ) => ({
    ...base,
    SYSTEM_ROLE: systemRole,
    MISSION_ROLE: options.missionRole,
    KYBERION_PERSONA: options.persona,
    KYBERION_DELEGATED_ROLE: '',
  }),
}));

const mocks = vi.hoisted(() => ({
  loadPipelineRunJournal: vi.fn(),
  spawnManagedProcess: vi.fn(),
  rootResolve: vi.fn(() => '/repo/dist/scripts/run_pipeline.js'),
  rootDir: vi.fn(() => '/repo'),
  assertSafeRepositoryPath: vi.fn((value: string) => value),
}));

vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));
vi.mock('./pipeline-run-journal.js', () => ({
  loadPipelineRunJournal: mocks.loadPipelineRunJournal,
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootResolve: mocks.rootResolve,
    rootDir: mocks.rootDir,
  },
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
}));

import {
  resetPipelineApprovalResumeState,
  resumePipelineRunAfterApproval,
} from './pipeline-approval-resume.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { capturePipelineResumePolicyEnvironment } from './pipeline-resume-policy-env.js';

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
        execution_authority: {
          system_role: 'chronos_mirror_v2',
          mission_role: 'chronos_operator',
          persona: '',
          scope: {
            tier: 'confidential',
            tenant_slug: 'original',
            organization_id: 'org-original',
            project_id: 'project-original',
            customer_stance: 'customer-original',
            nhi_id: 'actor-original',
          },
          nhi_id: 'nhi-original',
          agent_id: 'agent-original',
          task_grants_path: '',
          ...capturePipelineResumePolicyEnvironment(),
        },
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

  it('restores journal authority instead of inheriting the approving runtime', () => {
    const authority = mocks.loadPipelineRunJournal().started.execution_authority;
    authority.policy_env.KYBERION_ALLOW_UNSAFE_SHELL = '0';
    authority.policy_env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = 'original-strict-policy.json';
    vi.stubEnv('SYSTEM_ROLE', 'generation_schedule');
    vi.stubEnv('MISSION_ROLE', 'generation_scheduler');
    vi.stubEnv('KYBERION_DELEGATED_ROLE', 'generation_scheduler');
    vi.stubEnv('KYBERION_TENANT', 'approver');
    vi.stubEnv('KYBERION_PROJECT_ID', 'approver-project');
    vi.stubEnv('KYBERION_NHI_ID', 'nhi-approver');
    vi.stubEnv('KYBERION_TASK_GRANTS_PATH', 'approver-grants.json');
    vi.stubEnv('KYBERION_SUDO', 'true');
    vi.stubEnv('KYBERION_SUDO_SCOPE', 'all');
    vi.stubEnv('KYBERION_SUDO_KEY', 'approver-secret');
    vi.stubEnv('TASK_ID', 'approver-task');
    vi.stubEnv('KYBERION_ALLOW_UNSAFE_SHELL', '1');
    vi.stubEnv('KYBERION_PROVIDER_EGRESS_POLICY_PATH', 'approver-policy.json');
    try {
      expect(resumePipelineRunAfterApproval(record).status).toBe('started');
      expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          spawnOptions: expect.objectContaining({
            env: expect.objectContaining({
              SYSTEM_ROLE: 'chronos_mirror_v2',
              MISSION_ROLE: 'chronos_operator',
              KYBERION_DELEGATED_ROLE: '',
              KYBERION_PERSONA: '',
              KYBERION_TENANT: 'original',
              KYBERION_TIER: 'confidential',
              KYBERION_ORGANIZATION_ID: 'org-original',
              KYBERION_PROJECT_ID: 'project-original',
              KYBERION_CUSTOMER: 'customer-original',
              KYBERION_NHI_ACTOR: 'actor-original',
              KYBERION_NHI_ID: 'nhi-original',
              KYBERION_AGENT_ID: 'agent-original',
              KYBERION_TASK_GRANTS_PATH: '',
              KYBERION_SUDO: '',
              KYBERION_SUDO_SCOPE: '',
              KYBERION_SUDO_KEY: '',
              TASK_ID: '',
              KYBERION_ALLOW_UNSAFE_SHELL: '0',
              KYBERION_PROVIDER_EGRESS_POLICY_PATH: 'original-strict-policy.json',
            }),
          }),
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retains manual continuation for legacy journals without authority provenance', () => {
    const state = mocks.loadPipelineRunJournal();
    delete state.started.execution_authority;
    expect(resumePipelineRunAfterApproval(record)).toMatchObject({ status: 'not_applicable' });
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('transports the original egress and reasoning ceilings to the child wrapper', () => {
    const state = mocks.loadPipelineRunJournal();
    state.started.execution_authority.scope_policy = {
      read_tiers: ['confidential'],
      write_tier: 'confidential',
      purpose: 'original source',
      external_egress: 'deny',
      allowed_reasoning_backends: ['local-model'],
    };
    expect(resumePipelineRunAfterApproval(record).status).toBe('started');
    const args = mocks.spawnManagedProcess.mock.calls[0][0].args;
    expect(args[2]).toContain('withScopeEnvelope');
    expect(JSON.parse(args[4]).policy).toEqual(state.started.execution_authority.scope_policy);
  });

  it('keeps unsupported original policy controls on the manual original-runtime path', () => {
    const state = mocks.loadPipelineRunJournal();
    state.started.execution_authority.unsupported_policy_env = ['KYBERION_CUSTOM_POLICY_PATH'];
    expect(resumePipelineRunAfterApproval(record)).toMatchObject({
      status: 'not_applicable',
      reason: expect.stringContaining('pnpm pipeline --resume run-1'),
    });
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'cancelled', 'expired'] as const)(
    'settles %s only for an exact scoped library run',
    (status) => {
      const denied = {
        ...record,
        status,
        scope: { tier: 'confidential' as const, tenant_slug: 'tenant-a' },
      };
      expect(resumePipelineRunAfterApproval(denied).status).toBe('not_applicable');
      expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
      const state = mocks.loadPipelineRunJournal.mock.results[0]!.value;
      state.started.library_execution = { source_sha256: 'a'.repeat(64) };
      expect(resumePipelineRunAfterApproval(denied).status).toBe('started');
      expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            '--input-type=module',
            '-e',
            expect.any(String),
            'file:///repo/dist/scripts/run_pipeline.js',
            expect.any(String),
            '--resume',
            'run-1',
            '--journal-tier',
            'confidential',
            '--journal-tenant',
            'tenant-a',
          ],
        })
      );
    }
  );

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
        args: [
          '--input-type=module',
          '-e',
          expect.any(String),
          'file:///repo/dist/scripts/run_pipeline.js',
          expect.any(String),
          '--resume',
          'run-1',
        ],
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

  it('resumes the exact external-channel approval with its recorded effect correlation', () => {
    const correlationId = `external:${'a'.repeat(64)}`;
    const state = mocks.loadPipelineRunJournal();
    state.suspended.storage_channel = 'external-operation';
    state.suspended.approval_correlation_id = correlationId;
    const external = {
      ...record,
      channel: 'external-operation',
      storageChannel: 'external-operation',
      correlationId,
      accountability: {
        finalDecision: 'human_only' as const,
        effectBinding: 'meeting:chat',
        payloadHash: 'payload-hash',
      },
    };
    expect(resumePipelineRunAfterApproval(external).status).toBe('started');
    resetPipelineApprovalResumeState();
    expect(
      resumePipelineRunAfterApproval({ ...external, correlationId: `external:${'b'.repeat(64)}` })
        .status
    ).toBe('not_applicable');
    expect(resumePipelineRunAfterApproval({ ...external, accountability: undefined }).status).toBe(
      'not_applicable'
    );
    expect(resumePipelineRunAfterApproval({ ...external, id: 'other-approval' }).status).toBe(
      'not_applicable'
    );
    expect(
      resumePipelineRunAfterApproval({
        ...external,
        requestedByContext: { ...external.requestedByContext!, missionId: 'other-mission' },
      }).status
    ).toBe('not_applicable');
  });
});
