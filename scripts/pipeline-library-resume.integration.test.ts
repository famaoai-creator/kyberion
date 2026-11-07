import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from './fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '@agent/core/secure-io';
import { withExecutionContext as inSourceContext } from '@agent/core/authority';
import path from 'node:path';
let safeWriteFile: typeof import('@agent/core/secure-io').safeWriteFile;
let safeRmSync: typeof import('@agent/core/secure-io').safeRmSync;
let pathResolver: typeof import('@agent/core/path-resolver').pathResolver;
let withExecutionContextAsync: typeof import('@agent/core/authority').withExecutionContextAsync;
let logger: typeof import('@agent/core/core').logger;
let getSecret: typeof import('@agent/core/secret/secret-guard').getSecret;
let currentScopeEnvelope: typeof import('@agent/core/scope-envelope').currentScopeEnvelope;
let mintScopeEnvelope: typeof import('@agent/core/scope-envelope').mintScopeEnvelope;
let withScopeEnvelope: typeof import('@agent/core/scope-envelope').withScopeEnvelope;
let withScopeEnvOnly: typeof import('@agent/core/scope-context').withScopeEnvOnly;
let cancelApprovalRequest: typeof import('@agent/core/governance/approval-store').cancelApprovalRequest;
let decideApprovalRequest: typeof import('@agent/core/governance/approval-store').decideApprovalRequest;
let expireApprovalRequest: typeof import('@agent/core/governance/approval-store').expireApprovalRequest;
let loadApprovalRequest: typeof import('@agent/core/governance/approval-store').loadApprovalRequest;
let approvalStoreRoots: typeof import('@agent/core/governance/approval-store-paths').approvalStoreRoots;
let loadPipelineRunJournal: typeof import('@agent/core/pipeline/pipeline-run-journal').loadPipelineRunJournal;
let claimWorkItem: typeof import('@agent/core/workforce/work-coordination').claimWorkItem;
let createWorkItem: typeof import('@agent/core/workforce/work-coordination').createWorkItem;
let getWorkItem: typeof import('@agent/core/workforce/work-coordination').getWorkItem;
let releaseWorkItem: typeof import('@agent/core/workforce/work-coordination').releaseWorkItem;
let setWorkCoordinationNamespace: typeof import('@agent/core/workforce/work-coordination').setWorkCoordinationNamespace;
let clearWorkCoordinationNamespace: typeof import('@agent/core/workforce/work-coordination').clearWorkCoordinationNamespace;
let clearWorkCoordinationStore: typeof import('@agent/core/workforce/work-coordination').clearWorkCoordinationStore;
let executePipelineFile: typeof import('./pipeline-execution-part-results.js').executePipelineFile;
let resumeLibraryPipelineRun: typeof import('./pipeline-execution-part-results.js').resumeLibraryPipelineRun;

const sourceRoot = process.cwd();
const fixtureRoot = path.join(
  sourceRoot,
  'active/shared/tmp',
  `library-resume-root-${randomUUID()}`
);
const auditChainKey = Symbol.for('@kyberion/audit-chain');
const sourceAuditChainDescriptor = Object.getOwnPropertyDescriptor(globalThis, auditChainKey);

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, fixtureRoot);
  process.chdir(fixtureRoot);
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('VITEST', '');
  // The bootstrap I/O imports construct a process-global chain whose methods
  // capture the source checkout. resetModules alone cannot isolate that root.
  expect(Reflect.deleteProperty(globalThis, auditChainKey)).toBe(true);
  vi.resetModules();
  ({ safeWriteFile, safeRmSync } = await import('@agent/core/secure-io'));
  ({ pathResolver } = await import('@agent/core/path-resolver'));
  ({ withExecutionContextAsync } = await import('@agent/core/authority'));
  ({ logger } = await import('@agent/core/core'));
  ({ getSecret } = await import('@agent/core/secret/secret-guard'));
  ({ currentScopeEnvelope, mintScopeEnvelope, withScopeEnvelope } =
    await import('@agent/core/scope-envelope'));
  ({ withScopeEnvOnly } = await import('@agent/core/scope-context'));
  ({ cancelApprovalRequest, decideApprovalRequest, expireApprovalRequest, loadApprovalRequest } =
    await import('@agent/core/governance/approval-store'));
  ({ approvalStoreRoots } = await import('@agent/core/governance/approval-store-paths'));
  ({ loadPipelineRunJournal } = await import('@agent/core/pipeline/pipeline-run-journal'));
  ({
    claimWorkItem,
    createWorkItem,
    getWorkItem,
    releaseWorkItem,
    setWorkCoordinationNamespace,
    clearWorkCoordinationNamespace,
    clearWorkCoordinationStore,
  } = await import('@agent/core/workforce/work-coordination'));
  ({ executePipelineFile, resumeLibraryPipelineRun } =
    await import('./pipeline-execution-part-results.js'));
  expect(pathResolver.rootDir()).toBe(fixtureRoot);
  expect(pathResolver.primaryCheckoutRootDir()).toBe(fixtureRoot);
  const { auditChain } = await import('@agent/core/governance/audit-chain');
  expect(auditChain).not.toBe(sourceAuditChainDescriptor?.value);
  expect(Reflect.get(globalThis, auditChainKey)).toBe(auditChain);
  // Seed the onboarding runtime floor; bounded store APIs create their own partitions.
  const { safeMkdir } = await import('@agent/core/secure-io');
  const { writeTenantProfile } = await import('@agent/core/organization/tenant-registry');
  await withExecutionContextAsync(
    'mission_controller',
    async () => {
      safeMkdir(pathResolver.shared('runtime'));
      writeTenantProfile({
        tenant_slug: 'pipeline-delegation',
        display_name: 'Pipeline fixture',
        assigned_role: 'owner',
        status: 'active',
      });
    },
    'ecosystem_architect'
  );
}, 60000);

afterAll(() => {
  // All fixture operations have settled. Restore the exact process-global
  // bootstrap state before source-root I/O performs whole-fixture cleanup.
  if (sourceAuditChainDescriptor)
    Object.defineProperty(globalThis, auditChainKey, sourceAuditChainDescriptor);
  else Reflect.deleteProperty(globalThis, auditChainKey);
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  inSourceContext('ecosystem_architect', () =>
    removeFixture(fixtureRoot, { recursive: true, force: true })
  );
  vi.resetModules();
});

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
        // Tenant-scoped requests live in the tenant approval partitions.
        safeRmSync(roots.tenantApprovals, { recursive: true, force: true });
      },
      'ecosystem_architect',
      'pipeline-delegation'
    );
    // Preserve the suite's import-bound root until whole-fixture cleanup.
    for (const key of ['MISSION_ID', 'KYBERION_TASK_ID', 'PIPELINE_RESUME_FIXTURE_SECRET'])
      vi.stubEnv(key, '');
    vi.useRealTimers();
  });
  it.each(['approved', 'rejected', 'cancelled', 'expired'] as const)(
    'settles original %s attempt without replaying completed nodes',
    async (decision) => {
      const id = randomUUID();
      vi.stubEnv('MISSION_ID', '');
      vi.stubEnv('KYBERION_TASK_ID', '');
      const secret = `synthetic-approval-redaction-${id}`;
      vi.stubEnv('PIPELINE_RESUME_FIXTURE_SECRET', secret);
      await withExecutionContextAsync(
        'mission_controller',
        async () => expect(getSecret('PIPELINE_RESUME_FIXTURE_SECRET')).toBe(secret),
        undefined,
        ''
      );
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
              params: {
                input: 21,
                script: `/* ${secret} */ return Number(input) * 2;`,
                export_as: 'answer',
              },
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
          expect(() => getSecret('PIPELINE_RESUME_FIXTURE_SECRET')).toThrow(
            'CREDENTIAL_BINDING_REQUIRED'
          );
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
              resumeOwner: 'task',
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
          expect(pending.status, JSON.stringify(pending.results)).toBe('suspended');
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
          // A confidential pipeline run declares its posture at the mission boundary.
          expect(journal.started?.library_execution?.payload_scope).toMatchObject({
            tier: 'confidential',
            tenant_slug: tenant,
            training_use: 'no_training',
          });
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
          expect(approval.details).toContain('[REDACTED_SECRET]');
          expect(approval.details).not.toContain(secret);
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
          await expect(
            resumeLibraryPipelineRun(pending.runId, {
              tier: 'confidential',
              tenantSlug: tenant,
            })
          ).rejects.toThrow('live task tool binding');
          const sourceGuard = vi.fn(() => {
            throw new Error('pinned-source-mismatch');
          });
          await expect(
            resumeLibraryPipelineRun(
              pending.runId,
              {
                tier: 'confidential',
                tenantSlug: tenant,
              },
              () => undefined,
              sourceGuard
            )
          ).rejects.toThrow('pinned-source-mismatch');
          expect(sourceGuard).toHaveBeenCalledTimes(1);
          const completed = await resumeLibraryPipelineRun(
            pending.runId,
            {
              tier: 'confidential',
              tenantSlug: tenant,
            },
            () => undefined,
            (source) => expect(source).toContain('Exact library continuation')
          );
          expect(completed.status).toBe(decision === 'approved' ? 'succeeded' : 'aborted');
          if (decision === 'approved') expect(completed.runId).toBe(pending.runId);
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
