import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  loadBackgroundReviewNudgeState,
  recordBackgroundReviewActivity,
  backgroundReviewNudgeStatePath,
} from './background-review-nudge.js';
import { loadMemoryPromotionCandidate } from './memory-promotion-queue.js';
import { loadDistillCandidateRecord } from './distill-candidate-registry.js';
import {
  applyBackgroundReviewPipelinePatch,
  createBackgroundReviewApprovalRequest,
} from './background-review-patch.js';
import { approvalRequestLogicalPath, loadApprovalRequest } from './approval-store.js';
import {
  clearSurfaceOutboxMessage,
  listSurfaceOutboxMessages,
} from './surface-coordination-store.js';
import { resolveSurfaceApprovalReply } from './surface-approval-ui.js';
import {
  runBackgroundReviewFork,
  triggerBackgroundReviewFork,
} from './background-review-runner.js';

const queuePath = 'active/shared/tmp/test-memory-queue-background-review-runner.jsonl';
const sessionIds = new Set<string>();
const candidatePaths = new Set<string>();
const pipelineRefs = new Set<string>();
const backupRefs = new Set<string>();
const approvalRefs = new Set<string>();
const outboxRefs = new Set<string>();
const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
const originalRole = process.env.MISSION_ROLE;
const originalPersona = process.env.KYBERION_PERSONA;

function cleanup(): void {
  withExecutionContext('surface_runtime', () => {
    for (const sessionId of sessionIds) {
      safeRmSync(backgroundReviewNudgeStatePath(sessionId), { force: true });
    }
    for (const candidatePath of candidatePaths) {
      safeRmSync(candidatePath, { force: true });
    }
  });
  if (safeExistsSync(pathResolver.rootResolve(queuePath))) {
    withExecutionContext('surface_runtime', () =>
      safeRmSync(pathResolver.rootResolve(queuePath), { force: true })
    );
  }
  withExecutionContext('ecosystem_architect', () => {
    for (const ref of pipelineRefs) safeRmSync(pathResolver.rootResolve(ref), { force: true });
    for (const ref of backupRefs) safeRmSync(pathResolver.rootResolve(ref), { force: true });
  });
  withExecutionContext('mission_controller', () => {
    for (const approvalId of approvalRefs) {
      safeRmSync(
        pathResolver.rootResolve(approvalRequestLogicalPath('background-review', approvalId)),
        { force: true }
      );
    }
  });
  withExecutionContext('slack_bridge', () => {
    for (const messageId of outboxRefs) {
      clearSurfaceOutboxMessage('slack', messageId);
    }
  });
}

beforeAll(() => {
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePath;
  process.env.MISSION_ROLE = 'surface_runtime';
  process.env.KYBERION_PERSONA = 'worker';
});

afterEach(cleanup);

afterAll(() => {
  cleanup();
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
  if (originalRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = originalRole;
  if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = originalPersona;
});

describe('background-review-runner', () => {
  it('runs a detached review and queues a governed memory candidate', async () => {
    const sessionId = `runner-memory-${process.pid}-${Date.now()}`;
    sessionIds.add(sessionId);
    withExecutionContext('surface_runtime', () =>
      recordBackgroundReviewActivity({
        sessionId,
        activity: 'turn',
        config: { turnThreshold: 1, toolThreshold: 10 },
      })
    );
    const delegateTask = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('memory:enqueue');
      return JSON.stringify({
        action: 'memory_candidate',
        title: 'Reusable closure checklist',
        summary: 'Use a bounded closure checklist before marking a mission complete.',
        proposed_memory_kind: 'sop',
      });
    });

    const result = await runBackgroundReviewFork({
      sessionId,
      surface: 'slack',
      snapshot: 'The operator repeatedly used the same closure checklist.',
      backend: { delegateTask },
    });

    expect(result).toMatchObject({ status: 'queued', action: 'memory_candidate' });
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(loadMemoryPromotionCandidate(result.candidate_id!)).toMatchObject({
      source_type: 'task_session',
      sensitivity_tier: 'personal',
      ratification_required: true,
      evidence_refs: [`surface:slack:background-review:${sessionId}`],
    });
    expect(loadBackgroundReviewNudgeState(sessionId).review_pending).toBe(false);
  });

  it('rejects forbidden durable claims and releases the reservation', async () => {
    const sessionId = `runner-policy-${process.pid}-${Date.now()}`;
    sessionIds.add(sessionId);
    withExecutionContext('surface_runtime', () =>
      recordBackgroundReviewActivity({
        sessionId,
        activity: 'turn',
        config: { turnThreshold: 1, toolThreshold: 10 },
      })
    );
    const result = await runBackgroundReviewFork({
      sessionId,
      surface: 'telegram',
      snapshot: 'A temporary network failure happened once.',
      backend: {
        delegateTask: async () =>
          JSON.stringify({
            action: 'memory_candidate',
            summary: 'This was a temporary network failure and should be remembered.',
          }),
      },
    });

    expect(result.status).toBe('rejected');
    expect(loadBackgroundReviewNudgeState(sessionId).review_pending).toBe(false);
    expect(loadMemoryPromotionCandidate(result.candidate_id || '')).toBeNull();
  });

  it('stores skill/pipeline work as provenance-bearing proposals, never as direct patches', async () => {
    const sessionId = `runner-proposal-${process.pid}-${Date.now()}`;
    sessionIds.add(sessionId);
    const result = await runBackgroundReviewFork({
      sessionId,
      surface: 'discord',
      missionId: 'MSN-BACKGROUND-REVIEW-1',
      snapshot: 'The same existing pipeline step is repeatedly useful.',
      backend: {
        delegateTask: async () =>
          JSON.stringify({
            action: 'pipeline_proposal',
            title: 'Reuse bounded retry pipeline',
            summary:
              'Promote the existing bounded retry sequence as a reviewed pipeline candidate.',
            target_ref: 'pipelines/retry.json',
            patch: {
              operation: 'append_step',
              step: { op: 'system:log', params: { message: 'reviewed' } },
            },
          }),
      },
    });

    expect(result).toMatchObject({ status: 'queued', action: 'pipeline_proposal' });
    expect(result.approval_request_id).toBeUndefined();
    expect(result.approval_request_error).toMatch(/File not found/);
    const record = loadDistillCandidateRecord(result.candidate_id!);
    candidatePaths.add(
      pathResolver.shared(`runtime/distill-candidates/${result.candidate_id}.json`)
    );
    expect(record).toMatchObject({
      source_type: 'mission',
      tier: 'confidential',
      status: 'proposed',
      target_kind: 'sop_candidate',
      metadata: {
        action: 'pipeline_proposal',
        target_ref: 'pipelines/retry.json',
        patch: { operation: 'append_step' },
        provenance: { session_id: sessionId, generated_by: 'background-review-fork' },
      },
    });
  });

  it('stores a skill append-section proposal without applying it', async () => {
    const sessionId = `runner-skill-${process.pid}-${Date.now()}`;
    sessionIds.add(sessionId);
    const result = await runBackgroundReviewFork({
      sessionId,
      surface: 'slack',
      snapshot: 'A durable checklist belongs in the managed review skill.',
      backend: {
        delegateTask: async () =>
          JSON.stringify({
            action: 'skill_patch',
            title: 'Add review checklist',
            summary: 'Append a bounded review checklist to the managed skill.',
            target_ref: 'active/shared/runtime/background-review/skills/review/SKILL.md',
            patch: {
              operation: 'append_section',
              section: '## Review checklist\n\nVerify the output before promotion.',
            },
          }),
      },
    });

    expect(result).toMatchObject({ status: 'queued', action: 'skill_patch' });
    expect(result.approval_request_id).toBeUndefined();
    expect(result.approval_request_error).toMatch(/Skill target not found/);
    const record = loadDistillCandidateRecord(result.candidate_id!);
    candidatePaths.add(
      pathResolver.shared(`runtime/distill-candidates/${result.candidate_id}.json`)
    );
    expect(record).toMatchObject({
      status: 'proposed',
      metadata: {
        action: 'skill_patch',
        patch: { operation: 'append_section' },
        provenance: { generated_by: 'background-review-fork' },
      },
    });
  });

  it('runs the mission-scoped nudge-to-approved-pipeline path end to end', async () => {
    const sessionId = `runner-e2e-${process.pid}-${Date.now()}`;
    const targetRef = `pipelines/background-review-e2e-${process.pid}-${Date.now()}.json`;
    sessionIds.add(sessionId);
    pipelineRefs.add(targetRef);
    withExecutionContext('ecosystem_architect', () =>
      safeWriteFile(
        pathResolver.rootResolve(targetRef),
        `${JSON.stringify(
          {
            action: 'pipeline',
            name: 'background-review-e2e',
            version: '1.0.0',
            steps: [
              { id: 'before', role: 'sink', op: 'system:log', params: { message: 'before' } },
            ],
          },
          null
        )}\n`
      )
    );

    const trigger = triggerBackgroundReviewFork({
      sessionId,
      surface: 'slack',
      missionId: 'MSN-BACKGROUND-REVIEW-E2E',
      approvalChannel: 'e2e-channel',
      approvalThreadTs: 'e2e-thread',
      snapshot: 'The same bounded closure step was useful throughout this mission.',
      nudgeConfig: { turnThreshold: 1, toolThreshold: 10 },
      backend: {
        delegateTask: async () =>
          JSON.stringify({
            action: 'pipeline_proposal',
            title: 'Add closure review step',
            summary: 'Append the bounded closure review step to the existing pipeline.',
            target_ref: targetRef,
            patch: {
              operation: 'append_step',
              step: { id: 'after', role: 'sink', op: 'system:log', params: { message: 'after' } },
            },
          }),
      },
    });

    expect(trigger.review_due).toBe(true);
    expect(trigger.state.review_pending).toBe(true);
    expect(trigger.fork).toBeDefined();
    const forkResult = await trigger.fork!;
    expect(forkResult).toMatchObject({ status: 'queued', action: 'pipeline_proposal' });
    const candidateId = forkResult.candidate_id!;
    candidatePaths.add(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`));
    expect(loadBackgroundReviewNudgeState(sessionId).review_pending).toBe(false);

    const before = String(safeReadFile(pathResolver.rootResolve(targetRef), { encoding: 'utf8' }));
    const approvalId = forkResult.approval_request_id;
    expect(approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    approvalRefs.add(approvalId!);
    const approval = loadApprovalRequest('background-review', approvalId!);
    expect(approval).toMatchObject({
      id: approvalId,
      status: 'pending',
      correlationId: candidateId,
      accountability: { finalDecision: 'human_only' },
    });
    if (!approval) throw new Error('Background-review approval request was not persisted.');
    const notificationId = forkResult.approval_notification_id;
    expect(notificationId).toBeDefined();
    outboxRefs.add(notificationId!);
    expect(listSurfaceOutboxMessages('slack')).toContainEqual(
      expect.objectContaining({
        message_id: notificationId,
        correlation_id: approval.id,
        channel: 'e2e-channel',
        thread_ts: 'e2e-thread',
      })
    );
    const duplicateRequest = createBackgroundReviewApprovalRequest({
      candidateId,
      expectedSha256: createHash('sha256').update(before).digest('hex'),
      missionId: 'MSN-BACKGROUND-REVIEW-E2E',
    });
    expect(duplicateRequest.id).toBe(approval.id);
    const decided = resolveSurfaceApprovalReply({
      surface: 'slack',
      channel: 'e2e-channel',
      threadTs: 'e2e-thread',
      text: `appr:${approval.id}:approve`,
      decidedBy: 'e2e-operator',
    });
    expect(decided).toMatchObject({ handled: true, record: { status: 'approved' } });
    const applied = applyBackgroundReviewPipelinePatch({
      candidateId,
      expectedSha256: createHash('sha256').update(before).digest('hex'),
      approvedBy: 'e2e-operator',
      approvalRef: approval.id,
    });
    backupRefs.add(applied.backup_ref);

    const patched = JSON.parse(
      String(safeReadFile(pathResolver.rootResolve(targetRef), { encoding: 'utf8' }))
    ) as { steps: unknown[] };
    expect(patched.steps).toHaveLength(2);
    expect(loadDistillCandidateRecord(candidateId)).toMatchObject({
      status: 'promoted',
      promoted_ref: targetRef,
      tier: 'confidential',
    });
  });
});
