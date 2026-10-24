import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveMemoryEligibility } from '../knowledge/memory-provenance.js';
import * as path from 'node:path';
const transport = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: transport.route } }));
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { readJson } from '../foundation/json.js';
import { writeMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import { writeTenantProfile, tenantProfilePath } from '../organization/tenant-registry.js';
import { queryTenantKnowledge } from '../organization/tenant-knowledge-retrieval.js';
import { createDistillCandidateRecord } from '../knowledge/distill-candidate-registry.js';
import {
  saveExecutionFeedbackCandidate,
  executionFeedbackScopeRoot,
} from '../execution-feedback-candidates.js';
import { queueExecutionFeedbackLearning } from '../execution-feedback-learning.js';
import {
  loadMemoryPromotionCandidate,
  updateMemoryPromotionCandidateStatus,
  memoryPromotionQueuePath,
} from '../knowledge/memory-promotion-queue.js';
import { requestScopedLearningApproval } from '../knowledge/scoped-learning-approval.js';
import {
  computeApprovalPresentedDigest,
  decideApprovalRequest,
  loadApprovalRequest,
  approvalRequestLogicalPath,
  approvalStoreRoots,
} from '../governance/approval-store.js';
import { promoteMemoryCandidateToKnowledge } from '../knowledge/memory-promotion-workflow.js';
import { verifyScopedLearningPublication } from '../knowledge/scoped-learning-publication.js';
import {
  knowledgeVerificationLedgerPath,
  resolveKnowledgeVerification,
  type KnowledgeVerificationEntry,
} from '../knowledge/knowledge-verification.js';
import { loadKnowledgeUsageAggregate } from '../knowledge/knowledge-feedback-loop.js';
import { provisionTaskKnowledge } from '../task/task-knowledge-provisioning.js';
import {
  obtainTaskResultResponse,
  type TaskResultResponseDeps,
} from './mission-orchestration-task-response.js';
import type { MissionStateSummary } from './mission-context-pack-types.js';
import type { WorkItem } from '../workforce/work-coordination.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '../reasoning/reasoning-backend.js';

const cleanup = new Set<string>();
afterEach(() => {
  for (const file of cleanup)
    withExecutionContext(
      file.includes('/active/missions/') ? 'mission_controller' : 'ecosystem_architect',
      () => {
        if (safeExistsSync(file)) safeRmSync(file, { recursive: true, force: true });
      }
    );
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots()))
      safeRmSync(pathResolver.rootResolve(root + '/terminal'), { recursive: true, force: true });
  });
  cleanup.clear();
  resetReasoningBackend();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('approved scoped learning reaches later task execution', () => {
  it(
    'runs real feedback → review → publish → retrieve → provision → result attribution without changing authority',
    async () =>
      withExecutionContextAsync('ecosystem_architect', async () => {
        registerReasoningBackend(stubReasoningBackend);
        vi.stubEnv('KYBERION_DISABLE_EMBEDDINGS', '1');
        const suffix = randomUUID().slice(0, 8);
        const tenant = 'e2e-learning-' + suffix;
        // Bind the runtime reader identity; a query scope only narrows access.
        vi.stubEnv('KYBERION_TENANT', tenant);
        const memberId = 'e2e-reviewer-' + suffix;
        const scope = {
          tier: 'confidential' as const,
          tenant_slug: tenant,
          organization_id: 'org-learning',
          project_id: 'project-learning',
        };
        const missionId = 'MSN-LEARNING-E2E-' + suffix.toUpperCase();
        const root = pathResolver.sharedTmp('learning-delivery-e2e-' + suffix);
        cleanup.add(root);
        cleanup.add(pathResolver.knowledge('confidential/' + tenant));
        cleanup.add(pathResolver.missionDir(missionId, 'confidential'));
        cleanup.add(memberProfilePath(memberId));
        cleanup.add(tenantProfilePath(tenant));
        cleanup.add(executionFeedbackScopeRoot(scope));
        cleanup.add(memoryPromotionQueuePath(scope));
        vi.stubEnv('KYBERION_KNOWLEDGE_DELIVERY_DIR', path.join(root, 'delivery'));
        vi.stubEnv('KYBERION_KNOWLEDGE_USAGE_PATH', path.join(root, 'usage.json'));
        vi.stubEnv('KYBERION_KNOWLEDGE_FEEDBACK_DIR', path.join(root, 'feedback'));
        const now = new Date().toISOString();
        withExecutionContext('sovereign_concierge', () => {
          writeMemberProfile({
            member_id: memberId,
            display_name: 'Synthetic scoped reviewer',
            status: 'active',
            memberships: [{ tenant_slug: tenant, role: 'owner' }],
            access_registrations: [],
            created_at: now,
            updated_at: now,
          });
          writeTenantProfile({
            tenant_slug: tenant,
            display_name: 'Synthetic scoped learning fixture',
            status: 'active',
            assigned_role: 'owner',
            isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
          });
        });
        const source = createDistillCandidateRecord({
          candidate_id: 'FEEDBACK-E2E-' + suffix,
          source_type: 'task_session',
          tier: 'confidential',
          scope,
          title: 'Quasar reconciliation evidence procedure',
          summary:
            'Quasar reconciliation compares input totals against source records before the final report.',
          target_kind: 'sop_candidate',
          status: 'proposed',
          evidence_refs: ['task_session:quasar-' + suffix],
          metadata: { improvement_kind: 'execution_feedback' },
        });
        saveExecutionFeedbackCandidate(source);
        const review = queueExecutionFeedbackLearning(source.candidate_id, scope);
        const queued = loadMemoryPromotionCandidate(review.queue.candidate_id!, scope)!;
        const curation = {
          title: source.title,
          summary: queued.summary,
          content:
            'Quasar reconciliation: compare source totals, inspect discrepancies, preserve evidence, then finalize the report.',
          evidence_refs: queued.evidence_refs,
        };
        const request = requestScopedLearningApproval({
          candidate: { ...queued, curation },
          requester: { requestedBy: 'agent:synthetic-e2e', actorId: 'agent:synthetic-e2e' },
        });
        const [channel, requestId] = request.ref.split(':');
        cleanup.add(pathResolver.rootResolve(approvalRequestLogicalPath(channel!, requestId!)));
        const pending = loadApprovalRequest(channel!, requestId!)!;
        decideApprovalRequest('mission_controller', {
          channel: channel!,
          requestId: requestId!,
          decision: 'approved',
          decidedBy: 'user:' + memberId,
          decidedByType: 'human',
          authenticated: true,
          authMethod: 'surface_session',
          deciderIdentitySource: 'server_resolved',
          deciderPrincipal: {
            actor: { kind: 'human', id: 'user:' + memberId },
            provider: 'browser-session',
          },
          presentedDigest: computeApprovalPresentedDigest(pending),
        });
        updateMemoryPromotionCandidateStatus({
          candidateId: queued.candidate_id,
          scope,
          status: 'approved',
          curation,
          learningApprovalRef: request.ref,
        });
        const promoted = await promoteMemoryCandidateToKnowledge({
          candidateId: queued.candidate_id,
          scope,
        });
        const publication = verifyScopedLearningPublication(promoted.candidate)!;
        expect(publication).toBeDefined();
        expect(
          resolveMemoryEligibility({
            documentPath: promoted.promotedRef,
            sha256: publication.markdown_sha256,
            scope,
            consumerScope: { ...scope, mission_id: missionId, task_id: 'T1' },
          })
        ).toMatchObject({ eligible: true });
        const hits = await queryTenantKnowledge({
          tenantSlug: tenant,
          scope: { ...scope, mission_id: missionId, task_id: 'T1' },
          topic: 'Quasar reconciliation evidence',
          limit: 10,
        });
        expect(hits.map((hit) => hit.path)).toContain(promoted.promotedRef);
        expect(hits.find((hit) => hit.path === promoted.promotedRef)).toMatchObject({
          source_sha256: publication.markdown_sha256,
          learning_publication: publication,
        });
        const sibling = await queryTenantKnowledge({
          tenantSlug: tenant,
          scope: { ...scope, project_id: 'project-sibling', mission_id: missionId, task_id: 'T2' },
          topic: 'Quasar reconciliation evidence',
          limit: 10,
        });
        expect(sibling.map((hit) => hit.path)).not.toContain(promoted.promotedRef);

        const missionState: MissionStateSummary = {
          mission_id: missionId,
          mission_type: 'product_development',
          tier: 'confidential',
          tenant_slug: tenant,
          organization_id: scope.organization_id,
          status: 'active',
          execution_mode: 'local',
          priority: 3,
          confidence_score: 1,
          assigned_persona: 'worker',
          git: { branch: 'fixture', start_commit: '', latest_commit: '', checkpoints: [] },
          history: [],
          relationships: {
            project: { organization_id: scope.organization_id, project_id: scope.project_id },
          },
        };
        const workItem: WorkItem = {
          item_id: 'T1',
          title: 'Quasar reconciliation evidence',
          description: 'Apply the Quasar reconciliation evidence procedure.',
          status: 'ready',
          priority: 'normal',
          source: 'local',
          source_ref: 'mission:' + missionId + ':T1',
          project_id: scope.project_id,
          labels: [],
          dependencies: [],
          version: 1,
          created_at: now,
          updated_at: now,
        };
        const provisioned = await provisionTaskKnowledge({
          missionId,
          missionPath: path.join(root, 'mission'),
          tier: 'confidential',
          missionState,
          workItem,
          estimatedScope: 'L',
          contextBudgetChars: 20000,
          provider: 'laya-mlx',
        });
        const delivered = provisioned.deliveredKnowledgeRefs.find(
          (ref) => ref.path === promoted.promotedRef
        )!;
        expect(delivered).toBeDefined();
        expect(delivered.snapshot?.learning_publication).toEqual(publication);
        expect(provisioned.text).toContain(delivered.snapshot!.text);
        const savedPackText = provisioned.text;
        const original = String(
          safeReadFile(pathResolver.rootResolve(promoted.promotedRef), { encoding: 'utf8' })
        );
        transport.route.mockImplementation(async () => {
          safeWriteFile(
            pathResolver.rootResolve(promoted.promotedRef),
            original + '\nUnreviewed changed procedure.\n'
          );
          return { payload: { text: 'completed' } };
        });
        const taskResult = {
          summary: 'reconciliation complete',
          artifacts: [],
          verification_done: ['source totals matched'],
          gaps: [],
          needs: [],
          acceptance_evidence: [
            {
              criterion: 'totals match',
              status: 'passed' as const,
              evidence: 'source totals reconciled',
            },
          ],
          knowledge_feedback: { used: [promoted.promotedRef, 'knowledge/forged.md'] },
        };
        const deps: TaskResultResponseDeps = {
          recordMissionVisiblePrompt: () => undefined,
          resolveTaskDispatchTimeoutMs: () => 1000,
          parseTaskResultResponse: () => ({ taskResult, parseErrors: [], surfaceParseErrors: [] }),
          buildNeedsKnowledgeReinforcementLines: async () => [],
          buildTaskResultRetryPrompt: () => 'retry',
          stampTaskResultProvenance: () => undefined,
        };
        const responseInput = {
          missionId,
          task: { task_id: 'T1', description: workItem.description } as never,
          teamRole: 'implementer',
          agentId: 'synthetic-worker',
          prompt: provisioned.text,
          contextPackId: provisioned.pack!.context_pack_id,
          deliveredKnowledgeRefs: provisioned.deliveredKnowledgeRefs,
          securityScope: provisioned.pack!.security_scope,
        };
        await obtainTaskResultResponse(deps, responseInput);
        await obtainTaskResultResponse(deps, responseInput);
        expect(provisioned.text).toBe(savedPackText);
        const taskScope = { ...scope, mission_id: missionId, task_id: 'T1' };
        expect(
          resolveKnowledgeVerification([promoted.promotedRef], taskScope).get(promoted.promotedRef)
        ).toMatchObject({ state: 'changed_since_verified', evidence: 'worker_report' });
        const ledger = readJson<KnowledgeVerificationEntry[]>(
          knowledgeVerificationLedgerPath(taskScope)
        );
        expect(ledger.find((entry) => entry.document_path === promoted.promotedRef)).toMatchObject({
          last_success_fingerprint: publication.markdown_sha256.slice(0, 16),
          last_success_snapshot_sha256: delivered.snapshot!.sha256,
          last_success_scope_context: taskScope,
          success_count: 1,
        });
        expect(
          loadKnowledgeUsageAggregate(taskScope).find(
            (entry) => entry.document_path === promoted.promotedRef
          )?.used_count
        ).toBe(1);
        expect(
          loadKnowledgeUsageAggregate(taskScope).find(
            (entry) => entry.document_path === 'knowledge/forged.md'
          )
        ).toBeUndefined();
        const afterEdit = await queryTenantKnowledge({
          tenantSlug: tenant,
          scope: taskScope,
          topic: 'Quasar reconciliation evidence',
          limit: 10,
        });
        expect(afterEdit.map((hit) => hit.path)).not.toContain(promoted.promotedRef);
        expect(missionState.assigned_persona).toBe('worker');
        expect(provisioned.pack!.security_scope).toMatchObject({
          write_tier: 'confidential',
          tenant_slug: tenant,
          organization_id: scope.organization_id,
          project_id: scope.project_id,
        });
      }),
    30000
  );
});
