import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContextAsync } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  withScopeEnvelope,
} from '@agent/core/scope-envelope';
import { withScopeEnvOnly } from '@agent/core/scope-context';
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { approvalStoreRoots } from '@agent/core/governance/approval-store-paths';
import path from 'node:path';
import { loadPipelineRunJournal } from '@agent/core/pipeline/pipeline-run-journal';
import {
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
} from '@agent/core/workforce/work-coordination';
import {
  executePipelineFile,
  resumeLibraryPipelineRun,
} from './pipeline-execution-part-results.js';

// The real approval decision remains durable; only detached process launch is replaced.
vi.mock('@agent/core/pipeline/pipeline-approval-resume', () => ({
  resumePipelineRunAfterApproval: () => ({
    status: 'already_running',
    reason: 'integration runner owns continuation',
  }),
}));

describe('protected library execution approval continuation', () => {
  const paths: string[] = [];
  afterEach(async () => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
    vi.restoreAllMocks();
    await withExecutionContextAsync(
      'mission_controller',
      async () => {
        for (const file of paths.splice(0)) safeRmSync(file, { recursive: true, force: true });
        const roots = approvalStoreRoots();
        for (const root of Object.values(roots))
          safeRmSync(path.join(root, 'pipeline-execution-pipeline-delegation'), {
            recursive: true,
            force: true,
          });
      },
      'ecosystem_architect',
      'pipeline-delegation'
    );
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it.each(['approved', 'rejected', 'cancelled', 'expired'] as const)(
    'settles original %s attempt without replaying completed nodes',
    async (decision) => {
      const id = randomUUID();
      vi.stubEnv('MISSION_ID', '');
      vi.stubEnv('KYBERION_TASK_ID', '');
      const tenant = 'pipeline-delegation';
      const file = pathResolver.rootResolve(`active/shared/tmp/library-resume-${id}.json`);
      paths.push(file);
      safeWriteFile(
        file,
        JSON.stringify({
          action: 'pipeline',
          name: 'Exact library continuation',
          version: '1.0.0',
          steps: [
            { id: 'before', role: 'sink', op: 'system:log', params: { message: `before-${id}` } },
            {
              id: 'effect',
              role: 'source',
              produces: 'answer',
              op: 'core:transform',
              params: { input: 21, script: 'return Number(input) * 2;', export_as: 'answer' },
            },
            { id: 'after', role: 'sink', op: 'system:log', params: { message: `after-${id}` } },
          ],
        })
      );
      const observedPolicies: unknown[] = [];
      const log = vi.spyOn(logger, 'info').mockImplementation((...args) => {
        if (String(args[0]).includes(`after-${id}`))
          observedPolicies.push(currentScopeEnvelope()?.policy);
      });
      setWorkCoordinationNamespace(`library-resume-${id}`);
      await withExecutionContextAsync(
        'mission_controller',
        async () => {
          createWorkItem({
            itemId: id,
            title: 'Pipeline continuation',
            description: 'Original bounded internal work',
            status: 'ready',
            context: { tenant_slug: tenant },
            metadata: { dot_id: 'library-fixture', target: `pipeline:${file}` },
          });
          const claimed = claimWorkItem({
            itemId: id,
            actorPeerId: 'library-worker',
            purpose: 'original execution',
          });
          const owner = {
            id,
            tenantSlug: tenant,
            agentId: 'library-worker',
            attemptId: claimed.item.current_attempt_id!,
          };
          const sourcePolicy = {
            read_tiers: ['public', 'confidential'] as const,
            write_tier: 'confidential' as const,
            purpose: 'original restricted continuation',
            external_egress: 'deny' as const,
            allowed_reasoning_backends: ['local-model'],
          };
          const sourceEnvelope = withScopeEnvOnly(() =>
            mintScopeEnvelope({
              identity: {
                tier: 'confidential',
                tenant_slug: tenant,
                session_id: `source:${id}`,
                work_shape: 'pipeline',
              },
              env: {},
              policy: sourcePolicy,
            })
          );
          const pending = await withScopeEnvelope(sourceEnvelope, () =>
            executePipelineFile(file, {
              delegatedExecution: 'require',
              delegatedWorkItem: owner,
              payloadScope: {
                tier: 'confidential',
                tenant_slug: tenant,
                purpose: 'library continuation integration',
              },
              trustResolved: true,
              hasHuman: false,
              quiet: true,
            })
          );
          expect(pending.status).toBe('suspended');
          if (pending.status !== 'suspended') throw new Error('expected approval suspension');
          const journal = loadPipelineRunJournal(pending.runId, undefined, {
            tier: 'confidential',
            tenantSlug: tenant,
          });
          paths.push(journal.path);
          expect(journal.finished).toBeUndefined();
          expect(journal.completed_nodes.has('before')).toBe(true);
          expect(journal.started?.library_execution?.scope_identity).toMatchObject({
            tenant_slug: tenant,
            tier: 'confidential',
            session_id: `source:${id}`,
          });
          expect(journal.started?.execution_authority?.scope_policy).toEqual(sourcePolicy);
          releaseWorkItem({
            itemId: id,
            leaseId: claimed.lease.lease_id,
            actorPeerId: owner.agentId,
            nextStatus: 'blocked',
            metadata: {
              dot_executor: {
                mode: 'pipeline',
                status: 'blocked',
                awaiting_approval: true,
                pipeline_run_id: pending.runId,
                approval_request_id: pending.approvalRequestId,
                storage_channel: pending.storageChannel,
              },
            },
          });
          const approval = loadApprovalRequest(pending.storageChannel, pending.approvalRequestId)!;
          if (decision === 'expired') {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.parse(approval.expiresAt!) + 1);
            expireApprovalRequest('mission_controller', {
              channel: pending.storageChannel,
              requestId: approval.id,
            });
          } else if (decision === 'cancelled')
            cancelApprovalRequest('mission_controller', {
              channel: pending.storageChannel,
              requestId: approval.id,
              cancelledBy: 'user:owner',
              reason: 'withdrawn',
            });
          else
            decideApprovalRequest('mission_controller', {
              channel: pending.storageChannel,
              requestId: approval.id,
              decision,
              decidedBy: 'user:owner',
              decidedByType: 'human',
              authenticated: true,
              authMethod: 'terminal_attested',
              decidedVia: 'cli_tty_challenge',
              deciderIdentitySource: 'server_resolved',
              payloadHash: approval.accountability!.payloadHash,
              effectBinding: approval.accountability!.effectBinding,
            });
          vi.stubEnv('KYBERION_TASK_ID', 'ambient-unrelated-task');
          const completed = await resumeLibraryPipelineRun(pending.runId, {
            tier: 'confidential',
            tenantSlug: tenant,
          });
          expect(completed.status).toBe(decision === 'approved' ? 'succeeded' : 'aborted');
          expect(completed.context.answer).toBe(decision === 'approved' ? 42 : undefined);
          if (decision === 'approved')
            expect(observedPolicies).toEqual([
              expect.objectContaining({
                external_egress: 'deny',
                allowed_reasoning_backends: ['local-model'],
              }),
            ]);
          expect(
            log.mock.calls.filter((args) => String(args[0]).includes(`before-${id}`))
          ).toHaveLength(1);
          expect(getWorkItem(id)?.status).toBe(decision === 'approved' ? 'done' : 'archived');
          expect(getWorkItem(id)?.attempts).toHaveLength(1);
          expect(
            loadPipelineRunJournal(pending.runId, undefined, {
              tier: 'confidential',
              tenantSlug: tenant,
            }).finished?.status
          ).toBe(decision === 'approved' ? 'succeeded' : 'aborted');
          if (decision !== 'approved') {
            expect(getWorkItem(id)?.effect_ownership?.settlement).toBe('execution_aborted');
            expect(
              loadApprovalRequest(pending.storageChannel, approval.id)?.applyClaim
            ).toBeUndefined();
          }
          await expect(
            resumeLibraryPipelineRun(pending.runId, { tier: 'confidential', tenantSlug: tenant })
          ).rejects.toThrow('not resumable');
        },
        'ecosystem_architect',
        tenant
      );
    }
  );
});
