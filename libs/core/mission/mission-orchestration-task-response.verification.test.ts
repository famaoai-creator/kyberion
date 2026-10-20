import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
const mocks = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.route } }));
import {
  obtainTaskResultResponse,
  type TaskResultResponseDeps,
} from './mission-orchestration-task-response.js';
import type { TaskResultBlock } from './mission-orchestration-worker-contracts.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { readJson } from '../foundation/json.js';
import {
  createKnowledgeDeliverySnapshot,
  knowledgeTextSha256,
} from '../knowledge/knowledge-delivery-snapshot.js';
import {
  recordKnowledgeDelivery,
  loadKnowledgeUsageAggregate,
  type DeliveredKnowledgeRef,
} from '../knowledge/knowledge-feedback-loop.js';
import {
  knowledgeVerificationLedgerPath,
  resolveKnowledgeVerification,
  type KnowledgeVerificationEntry,
} from '../knowledge/knowledge-verification.js';

const root = pathResolver.sharedTmp('task-response-snapshot-' + process.pid);
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'PRJ-1',
  mission_id: 'MSN-VERIFY',
  task_id: 'T1',
};
const documentPath = path
  .relative(pathResolver.rootDir(), path.join(root, 'runbook.md'))
  .replaceAll('\\', '/');
const beforeText = '# Runbook\n\nUse the tested workflow.\n';
let delivered: DeliveredKnowledgeRef[];
const keys = [
  'KYBERION_KNOWLEDGE_DELIVERY_DIR',
  'KYBERION_KNOWLEDGE_USAGE_PATH',
  'KYBERION_KNOWLEDGE_FEEDBACK_DIR',
] as const;
let saved: Array<string | undefined>;
beforeEach(() => {
  saved = keys.map((key) => process.env[key]);
  process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = path.join(root, 'delivery');
  process.env.KYBERION_KNOWLEDGE_USAGE_PATH = path.join(root, 'usage.json');
  process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = path.join(root, 'feedback');
  safeMkdir(root, { recursive: true });
  safeWriteFile(path.join(root, 'runbook.md'), beforeText);
  delivered = recordKnowledgeDelivery({
    missionId: scope.mission_id,
    taskId: scope.task_id,
    scope,
    refs: [
      {
        path: documentPath,
        snapshot: createKnowledgeDeliverySnapshot({
          text: 'Use the tested workflow.',
          form: 'pack',
          context_pack_id: 'CPK-PINNED',
          source_sha256: knowledgeTextSha256(beforeText),
        }),
      },
    ],
  })!.refs;
  mocks.route.mockResolvedValue({ payload: { text: 'result' } });
});
afterEach(() => {
  keys.forEach((key, index) =>
    saved[index] === undefined ? delete process.env[key] : (process.env[key] = saved[index])
  );
  safeRmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function run(
  overrides: Partial<TaskResultBlock> = {},
  options: {
    parseErrors?: string[];
    surfaceErrors?: string[];
    projectId?: string;
    refs?: DeliveredKnowledgeRef[];
  } = {}
) {
  const result: TaskResultBlock = {
    summary: 'done',
    artifacts: [],
    verification_done: ['tests passed'],
    gaps: [],
    needs: [],
    knowledge_feedback: { used: [documentPath] },
    ...overrides,
  };
  const deps: TaskResultResponseDeps = {
    recordMissionVisiblePrompt: () => undefined,
    resolveTaskDispatchTimeoutMs: () => 1000,
    parseTaskResultResponse: () => ({
      taskResult: result,
      parseErrors: options.parseErrors || [],
      surfaceParseErrors: options.surfaceErrors || [],
    }),
    buildNeedsKnowledgeReinforcementLines: async () => [],
    buildTaskResultRetryPrompt: () => 'retry',
    stampTaskResultProvenance: () => undefined,
  };
  return obtainTaskResultResponse(deps, {
    missionId: scope.mission_id,
    task: { task_id: scope.task_id, description: 'test' } as never,
    teamRole: 'implementer',
    agentId: 'agent-1',
    prompt: 'use the pinned knowledge',
    contextPackId: 'CPK-PINNED',
    deliveredKnowledgeRefs: options.refs || delivered,
    securityScope: {
      tenant_slug: scope.tenant_slug,
      organization_id: scope.organization_id,
      project_id: options.projectId || scope.project_id,
      mission_id: scope.mission_id,
      read_tiers: ['public', 'confidential'],
      write_tier: 'confidential',
      purpose: 'mission-execution',
    },
  });
}
const verification = () => resolveKnowledgeVerification([documentPath], scope).get(documentPath);

describe('task result snapshot attribution', () => {
  it('never credits bytes changed during a run, and retains exact scope and worker-report evidence', async () => {
    const originalSha = delivered[0].snapshot!.sha256;
    mocks.route.mockImplementation(async () => {
      safeWriteFile(path.join(root, 'runbook.md'), '# New, unseen procedure\n');
      // A caller changing the original object cannot replace the dispatch-owned receipt.
      delivered[0].snapshot!.text = 'unseen bytes';
      return { payload: { text: 'result' } };
    });
    await run();
    expect(verification()).toMatchObject({
      state: 'changed_since_verified',
      evidence: 'worker_report',
    });
    const entries = readJson<KnowledgeVerificationEntry[]>(knowledgeVerificationLedgerPath(scope));
    expect(entries[0]).toMatchObject({
      last_success_fingerprint: knowledgeTextSha256(beforeText).slice(0, 16),
      last_success_snapshot_sha256: originalSha,
      last_success_scope_context: scope,
      success_count: 1,
    });
  });

  it('rejects forged used paths and a receipt belonging to a sibling project', async () => {
    await run({ knowledge_feedback: { used: ['knowledge/forged.md'] } });
    await run({}, { projectId: 'PRJ-SIBLING' });
    expect(verification()).toBeUndefined();
    expect(loadKnowledgeUsageAggregate(scope)).toMatchObject([
      { document_path: documentPath, used_count: 0 },
    ]);
    expect(
      loadKnowledgeUsageAggregate(scope).find(
        (entry) => entry.document_path === 'knowledge/forged.md'
      )
    ).toBeUndefined();
  });

  it.each([
    { gaps: ['verification failed'] },
    { needs: ['missing input'] },
    { verification_done: [] },
    {
      acceptance_evidence: [
        { criterion: 'tests pass', status: 'failed' as const, evidence: 'red' },
      ],
    },
  ])('records usage but not verification for incomplete/failed results %j', async (result) => {
    await run(result);
    expect(verification()).toBeUndefined();
    expect(loadKnowledgeUsageAggregate(scope)[0].used_count).toBe(1);
  });

  it('does not verify parse-invalid or surface-invalid responses', async () => {
    await run({}, { parseErrors: ['invalid result'] });
    await run({}, { surfaceErrors: ['invalid evidence surface'] });
    expect(verification()).toBeUndefined();
  });

  it('deduplicates repeated task results for usage and verification', async () => {
    await run();
    await run();
    expect(verification()).toMatchObject({ state: 'verified', evidence: 'worker_report' });
    expect(loadKnowledgeUsageAggregate(scope)[0].used_count).toBe(1);
    expect(
      readJson<KnowledgeVerificationEntry[]>(knowledgeVerificationLedgerPath(scope))[0]
        .success_count
    ).toBe(1);
  });

  it('keeps incomplete and complete observations separate, then deduplicates each', async () => {
    await run({}, { parseErrors: ['incomplete parse'] });
    expect(verification()).toBeUndefined();
    await run();
    await run();
    expect(verification()?.state).toBe('verified');
    expect(loadKnowledgeUsageAggregate(scope)[0].used_count).toBe(2);
    expect(
      readJson<KnowledgeVerificationEntry[]>(knowledgeVerificationLedgerPath(scope))[0]
        .success_count
    ).toBe(1);
  });

  it('does not record a success when the usage receipt cannot be persisted', async () => {
    const blocked = path.join(root, 'not-a-directory');
    safeWriteFile(blocked, 'occupied');
    process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = blocked;
    await run();
    process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = path.join(root, 'feedback');
    expect(verification()).toBeUndefined();
    expect(loadKnowledgeUsageAggregate(scope)[0].used_count).toBe(0);
  });

  it('never verifies a path-only legacy delivery or an ambiguous multi-version path claim', async () => {
    const legacy = recordKnowledgeDelivery({
      missionId: scope.mission_id,
      taskId: scope.task_id,
      scope,
      refs: [{ path: documentPath }],
    })!.refs;
    await run({}, { refs: legacy });
    expect(verification()).toBeUndefined();
    const other = recordKnowledgeDelivery({
      missionId: scope.mission_id,
      taskId: scope.task_id,
      scope,
      refs: [
        {
          path: documentPath,
          snapshot: createKnowledgeDeliverySnapshot({
            text: 'different visible excerpt',
            source_sha256: knowledgeTextSha256(beforeText),
            form: 'needs_retry',
          }),
        },
      ],
    })!.refs;
    await run({}, { refs: [...delivered, ...other] });
    expect(verification()).toBeUndefined();
  });
});
