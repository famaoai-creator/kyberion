/**
 * HA-01 local mission E2E.
 *
 * This command requires an already-active mission created and started through
 * mission_controller. It exercises the real surface message entrypoint with
 * a deterministic reasoning backend, then proves surface-token approval and
 * hash-bound application. All temporary governed artifacts are removed in a
 * finally block; the mission itself is never mutated by this harness.
 */

import { createHash } from 'node:crypto';
import {
  applyBackgroundReviewPipelinePatch,
  inspectBackgroundReviewProposal,
} from '@agent/core/background-review-patch';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core/reasoning-backend';
import { resolveSurfaceApprovalReply } from '@agent/core/surface-approval-ui';
import { runSurfaceMessageConversation } from '@agent/core/surface-runtime-orchestrator';
import {
  approvalRequestLogicalPath,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core/approval-store';
import {
  backgroundReviewNudgeStatePath,
  recordBackgroundReviewActivity,
} from '@agent/core/background-review-nudge';
import {
  clearSurfaceOutboxMessage,
  listSurfaceNotifications,
  listSurfaceOutboxMessages,
} from '@agent/core/surface-coordination-store';
import { findMissionPath, pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { loadStateAtPath } from '@agent/core/mission-state';
import { loadPipelineAdfAtPath } from '@agent/core/pipeline-contract';
import type { EventScope } from '@agent/core/event-scope';
import * as path from 'node:path';
import { defineScript, isDirectScript } from './lib/harness.js';

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

function usage(): never {
  throw new Error(
    'Usage: pnpm kyberion background-review mission-e2e --mission-id <active-mission-id> [--surface presence|slack]'
  );
}

function assertActiveMission(missionId: string): void {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) throw new Error(`Mission not found: ${missionId}`);
  const statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'));
  if (!safeLstat(statePath).isFile()) {
    throw new Error(`Mission state must be a regular file: ${statePath}`);
  }
  const state = withExecutionContext('mission_controller', () => loadStateAtPath(statePath));
  if (!state || state.mission_id.toUpperCase() !== missionId || state.status !== 'active') {
    throw new Error(`Mission must be active: ${missionId} (status=${state.status || 'unknown'})`);
  }
}

async function waitForApproval(
  missionId: string,
  channel: string,
  threadTs: string,
  timeoutMs = 10_000
): Promise<ApprovalRequestRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = listApprovalRequests({
      storageChannels: ['background-review'],
      status: 'pending',
    }).find(
      (candidate) =>
        candidate.channel === channel &&
        candidate.threadTs === threadTs &&
        candidate.requestedByContext?.missionId === missionId
    );
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for background-review approval on ${channel}/${threadTs}`);
}

async function main(argv: string[]): Promise<void> {
  const missionId = flag(argv, '--mission-id').toUpperCase();
  const surface = flag(argv, '--surface') || 'slack';
  if (!missionId) usage();
  if (surface !== 'slack' && surface !== 'presence') {
    throw new Error(
      'The deterministic mission E2E currently supports --surface presence or slack.'
    );
  }
  assertActiveMission(missionId);

  const runKey = `${process.pid}-${Date.now()}`;
  const channel = `ha01-e2e-${runKey}`;
  const threadTs = `thread-${runKey}`;
  const sessionKey = [surface, channel, threadTs].join(':');
  const sessionId = `surface-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`;
  const targetRef = `pipelines/background-review-mission-e2e-${runKey}.json`;
  const targetPath = pathResolver.rootResolve(targetRef);
  const candidateIds: string[] = [];
  let approvalId: string | undefined;
  let notificationId: string | undefined;
  let notificationScope: EventScope | undefined;
  let backupRef: string | undefined;

  try {
    withExecutionContext('ecosystem_architect', () =>
      safeWriteFile(
        targetPath,
        `${JSON.stringify(
          {
            action: 'pipeline',
            name: 'background-review-mission-e2e',
            version: '1.0.0',
            steps: [
              { id: 'before', role: 'sink', op: 'system:log', params: { message: 'before' } },
            ],
          },
          null
        )}\n`
      )
    );

    registerReasoningBackend({
      ...stubReasoningBackend,
      delegateTask: async () =>
        JSON.stringify({
          action: 'pipeline_proposal',
          title: 'Mission E2E closure step',
          summary: 'Append the bounded closure step used by this active mission.',
          target_ref: targetRef,
          patch: {
            operation: 'append_step',
            step: { id: 'after', role: 'sink', op: 'system:log', params: { message: 'after' } },
          },
        }),
    });

    withExecutionContext('surface_runtime', () => {
      for (let index = 0; index < 9; index += 1) {
        recordBackgroundReviewActivity({
          sessionId,
          activity: 'turn',
          config: { turnThreshold: 10, toolThreshold: 10 },
        });
      }
    });

    const conversation = await runSurfaceMessageConversation({
      surface,
      text: 'ナレッジで planner を調べて',
      channel,
      threadTs,
      correlationId: `ha01-e2e-${runKey}`,
      senderAgentId: 'kyberion:slack-bridge',
      agentId: 'slack-surface-agent',
      missionId,
      awaitBackgroundReviewFork: true,
    });
    const approval = await waitForApproval(missionId, channel, threadTs);
    approvalId = approval.id;
    candidateIds.push(approval.correlationId);

    const notification =
      surface === 'presence'
        ? listSurfaceNotifications('presence', { includeTenantNamespaces: true }).find(
            (message) =>
              message.request_id === approval.id &&
              message.channel === channel &&
              message.thread_ts === threadTs
          )
        : listSurfaceOutboxMessages(surface, { includeTenantNamespaces: true }).find(
            (message) =>
              message.correlation_id === approval.id &&
              message.channel === channel &&
              message.thread_ts === threadTs
          );
    if (!notification)
      throw new Error('Background-review approval outbox notification was not created.');
    notificationId =
      'message_id' in notification ? notification.message_id : notification.notification_id;
    notificationScope = notification.scope;
    if (!notification.text.includes(`appr:${approval.id}:approve`)) {
      throw new Error('Approval outbox notification did not contain the surface approval token.');
    }

    const decision = resolveSurfaceApprovalReply({
      surface,
      channel,
      threadTs,
      text: `appr:${approval.id}:approve`,
      decidedBy: 'ha01-e2e-human',
    });
    if (decision.record?.status !== 'approved') {
      throw new Error(
        `Surface approval did not approve the proposal: ${decision.reply || 'unknown'}`
      );
    }

    const preview = inspectBackgroundReviewProposal(approval.correlationId);
    const applied = applyBackgroundReviewPipelinePatch({
      candidateId: approval.correlationId,
      expectedSha256: preview.expectedSha256,
      approvedBy: 'ha01-e2e-human',
      approvalRef: approval.id,
    });
    backupRef = applied.backup_ref;
    const safeTargetPath = assertSafeRepositoryPath(targetPath);
    if (!safeLstat(safeTargetPath).isFile()) {
      throw new Error(`Mission pipeline target must be a regular file: ${safeTargetPath}`);
    }
    const patched = loadPipelineAdfAtPath(safeTargetPath);
    if (patched.steps.length !== 2) throw new Error('Mission E2E patch was not applied.');

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mission_id: missionId,
          surface,
          conversation_reply_preview: conversation.text.slice(0, 160),
          candidate_id: approval.correlationId,
          approval_request_id: approval.id,
          approval_notification_id: notificationId,
          applied,
        },
        null,
        2
      )}\n`
    );
  } finally {
    resetReasoningBackend();
    withExecutionContext('surface_runtime', () => {
      safeRmSync(backgroundReviewNudgeStatePath(sessionId), { force: true });
      for (const candidateId of candidateIds) {
        safeRmSync(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`), {
          force: true,
        });
      }
    });
    if (approvalId) {
      withExecutionContext('mission_controller', () =>
        safeRmSync(
          pathResolver.rootResolve(approvalRequestLogicalPath('background-review', approvalId!)),
          {
            force: true,
          }
        )
      );
    }
    if (notificationId) {
      if (surface === 'presence') {
        withExecutionContext('surface_runtime', () =>
          safeRmSync(pathResolver.shared(`runtime/presence/notifications/${notificationId}.json`), {
            force: true,
          })
        );
      } else {
        withExecutionContext('slack_bridge', () =>
          clearSurfaceOutboxMessage(surface, notificationId!, notificationScope)
        );
      }
    }
    withExecutionContext('ecosystem_architect', () => {
      safeRmSync(targetPath, { force: true });
      if (backupRef) safeRmSync(pathResolver.rootResolve(backupRef), { force: true });
    });
  }
}

const script = defineScript({
  name: 'background-review:mission-e2e',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (
  isDirectScript(import.meta.url, 'background_review_mission_e2e.ts') ||
  isDirectScript(import.meta.url, 'background_review_mission_e2e.js')
) {
  void script();
}
