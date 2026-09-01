import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAndRepairAdf } from './adf-repair-agent.js';
import { runBackgroundReviewFork } from './background-review-runner.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import { knowledgeDeliveryLogDir } from './src/knowledge-feedback-loop.js';
import {
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';

vi.mock('./delegated-task-observability.js', () => ({
  startDelegatedTaskTrace: vi.fn(() => ({ traceId: 'test-trace' })),
  completeDelegatedTaskTrace: vi.fn(),
}));

// KP-02: mocked so the delegation-context tests below are deterministic and
// do not depend on the real knowledge/product/evolution corpus contents.
vi.mock('./distill-knowledge-injector.js', () => ({
  findRelevantDistilledKnowledge: vi.fn(async () => []),
}));

const tmpRoot = pathResolver.sharedTmp('adf-repair-agent-tests');
// KP-02: hermetic isolation for knowledge delivery telemetry, same
// convention as knowledge-feedback-loop.test.ts (KP-05).
const knowledgeDeliveryDirOverride = pathResolver.sharedTmp(
  `kp02-adf-repair-agent-knowledge-delivery/${process.pid}`
);
const originalKnowledgeDeliveryDir = process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;

function fixturePath(name: string): string {
  return path.join(tmpRoot, name);
}

function writeFixture(name: string, body: string): string {
  const filePath = fixturePath(name);
  safeWriteFile(filePath, body, { encoding: 'utf8', mkdir: true });
  return filePath;
}

function readFixture(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

function registerFakeRepairBackend(delegateTask: ReasoningBackend['delegateTask']) {
  const backend: ReasoningBackend = {
    ...stubReasoningBackend,
    name: 'fake-repair',
    delegateTask,
  };
  registerReasoningBackend(backend);
}

function registerNativeWorkItemBackend(delegateTask: ReasoningBackend['delegateTask']) {
  registerReasoningBackend({
    ...stubReasoningBackend,
    name: 'legacy-test-backend',
    model: 'legacy-test-model',
    delegateTask,
    getNativeSubagentAdopter: () => ({
      id: 'test-native-adopter',
      dispatch: vi.fn(async (instruction: string) =>
        instruction.includes('background review')
          ? JSON.stringify({ action: 'no_action' })
          : JSON.stringify({ capability: 'demo', action: 'run' })
      ),
      getInfo: () => ({
        provider: 'test-native-provider',
        model: 'test-native-model',
        threadId: 'thread-caller-routing',
        turnId: 'turn-caller-routing',
      }),
    }),
  });
}

describe('validateAndRepairAdf', () => {
  beforeEach(() => {
    safeMkdir(tmpRoot, { recursive: true });
    resetReasoningBackend();
    vi.mocked(findRelevantDistilledKnowledge).mockReset();
    vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue([]);
    process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = knowledgeDeliveryDirOverride;
    safeRmSync(knowledgeDeliveryDirOverride, { recursive: true, force: true });
    setWorkCoordinationNamespace(`adf-repair-agent-caller-tests-${process.pid}`);
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
    resetReasoningBackend();
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
    safeRmSync(knowledgeDeliveryDirOverride, { recursive: true, force: true });
    if (originalKnowledgeDeliveryDir === undefined)
      delete process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
    else process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = originalKnowledgeDeliveryDir;
  });

  it('rejects an ADF repair target outside the repository root', async () => {
    await expect(
      validateAndRepairAdf('../../outside-adf.json', 'capability-input')
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects an ADF repair target reached through a symbolic link', async () => {
    const targetPath = writeFixture(
      'symlink-target.json',
      JSON.stringify({ capability: 'demo', action: 'run' })
    );
    const linkPath = fixturePath('symlink-adf.json');
    safeSymlinkSync(targetPath, linkPath);

    await expect(validateAndRepairAdf(linkPath, 'capability-input')).rejects.toThrow(
      '[RESOURCE_PATH_SYMLINK]'
    );
  });

  it('routes work-item ADF repair through the coordinated native path', async () => {
    const delegateTask = vi.fn(async () => {
      throw new Error('legacy delegateTask must not be called');
    });
    registerNativeWorkItemBackend(delegateTask);
    const item = createWorkItem({
      itemId: 'WI-ADF-CALLER-ROUTING',
      title: 'ADF caller routing',
      description: 'test coordinated ADF repair',
      projectId: 'PROJECT-CALLER',
      status: 'ready',
      context: {
        organization_id: 'org-canonical',
        tenant_slug: 'tenant-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        task_id: 'task-canonical',
      },
    });
    const filePath = writeFixture(
      'caller-routing-adf.json',
      JSON.stringify({ capability: 'demo' })
    );

    const result = await validateAndRepairAdf(filePath, 'capability-input', {
      workItemId: item.item_id,
    });
    const stored = getWorkItem(item.item_id)!;
    const attempt = stored.attempts?.[0];
    if (!attempt) throw new Error('expected ADF repair attempt to be recorded');

    expect(result.repaired).toBe(true);
    expect(delegateTask).not.toHaveBeenCalled();
    expect(stored.status).toBe('done');
    expect(attempt).toMatchObject({
      attempt_id: expect.any(String),
      status: 'released',
      ended_at: expect.any(String),
    });
    expect(stored.item_id).toBe(item.item_id);
    expect(stored.metadata).toMatchObject({
      attempt_id: expect.any(String),
      work_item_id: item.item_id,
      provider: 'test-native-provider',
      model_id: 'test-native-model',
      native_subagent: expect.objectContaining({ adopter_id: 'test-native-adopter' }),
      lease_status: 'released',
      result: expect.objectContaining({ status: 'succeeded' }),
      security_scope: expect.objectContaining({
        tenant_id: 'tenant-canonical',
        organization_id: 'org-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        read_tiers: ['public'],
        write_tier: 'public',
      }),
    });
    expect(attempt.metadata).toMatchObject({
      work_item_id: item.item_id,
      security_scope: expect.objectContaining({
        tenant_id: 'tenant-canonical',
        organization_id: 'org-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        read_tiers: ['public'],
        write_tier: 'public',
      }),
    });
    expect(stored.context).toMatchObject({
      tenant_slug: 'tenant-canonical',
      organization_id: 'org-canonical',
      mission_id: 'mission-canonical',
      project_id: 'project-canonical',
      task_id: 'task-canonical',
    });
  });

  it('routes work-item background review through the coordinated native path', async () => {
    const delegateTask = vi.fn(async () => {
      throw new Error('legacy delegateTask must not be called');
    });
    registerNativeWorkItemBackend(delegateTask);
    const item = createWorkItem({
      itemId: 'WI-REVIEW-CALLER-ROUTING',
      title: 'Review caller routing',
      description: 'test coordinated background review',
      projectId: 'PROJECT-CALLER',
      status: 'ready',
      context: {
        organization_id: 'org-canonical',
        tenant_slug: 'tenant-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        task_id: 'task-canonical',
      },
    });

    const result = await runBackgroundReviewFork({
      sessionId: 'caller-routing-review',
      surface: 'slack',
      snapshot: 'review snapshot',
      workItemId: item.item_id,
      backend: { delegateTask },
    });
    const stored = getWorkItem(item.item_id)!;
    const attempt = stored.attempts?.[0];
    if (!attempt) throw new Error('expected background review attempt to be recorded');

    expect(result).toMatchObject({ status: 'no_action', action: 'no_action' });
    expect(delegateTask).not.toHaveBeenCalled();
    expect(stored.status).toBe('review');
    expect(attempt).toMatchObject({
      attempt_id: expect.any(String),
      status: 'released',
      ended_at: expect.any(String),
    });
    expect(stored.item_id).toBe(item.item_id);
    expect(stored.metadata).toMatchObject({
      attempt_id: expect.any(String),
      work_item_id: item.item_id,
      provider: 'test-native-provider',
      model_id: 'test-native-model',
      native_subagent: expect.objectContaining({ adopter_id: 'test-native-adopter' }),
      lease_status: 'released',
      result: expect.objectContaining({ status: 'succeeded' }),
      security_scope: expect.objectContaining({
        tenant_id: 'tenant-canonical',
        organization_id: 'org-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        read_tiers: ['public'],
        write_tier: 'public',
      }),
    });
    expect(attempt.metadata).toMatchObject({
      work_item_id: item.item_id,
      security_scope: expect.objectContaining({
        tenant_id: 'tenant-canonical',
        organization_id: 'org-canonical',
        mission_id: 'mission-canonical',
        project_id: 'project-canonical',
        read_tiers: ['public'],
        write_tier: 'public',
      }),
    });
    expect(stored.context).toMatchObject({
      tenant_slug: 'tenant-canonical',
      organization_id: 'org-canonical',
      mission_id: 'mission-canonical',
      project_id: 'project-canonical',
      task_id: 'task-canonical',
    });
  });

  it('passes valid ADF input through without repair', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'valid.json',
      JSON.stringify({ capability: 'demo', action: 'run' }, null, 2)
    );

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result).toEqual({ repaired: false });
    expect(delegateTask).not.toHaveBeenCalled();
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('repairs lightweight JSON defects without delegating to the reasoning backend', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture('trailing-comma.json', '{ capability: "demo", action: "run", }');

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result).toEqual({ repaired: false });
    expect(delegateTask).not.toHaveBeenCalled();
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('uses a delegated JSON repair result only after it validates against the schema', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo', action: 'run' }));
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'schema-invalid.json',
      JSON.stringify({ capability: 'demo' }, null, 2)
    );

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(true);
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('delegates unrecoverable parse errors and writes the repaired JSON returned by the backend', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo', action: 'run' }));
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture('unparseable.json', 'this is not json');

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(true);
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFixture(filePath))).toEqual({ capability: 'demo', action: 'run' });
  });

  it('does not overwrite the file when delegated repair output is invalid', async () => {
    const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo' }));
    registerFakeRepairBackend(delegateTask);
    const original = JSON.stringify({ capability: 'demo' }, null, 2);
    const filePath = writeFixture('unrepaired.json', original);

    const result = await validateAndRepairAdf(filePath, 'capability-input');

    expect(result.repaired).toBe(false);
    expect(result.errors?.join('\n')).toContain('action');
    expect(readFixture(filePath)).toBe(original);
  });

  it('rejects pipeline ADF guardrail violations without delegating', async () => {
    const delegateTask = vi.fn(stubReasoningBackend.delegateTask);
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'guardrail.json',
      JSON.stringify(
        {
          steps: [
            {
              op: 'demo:step',
              params: {},
              hooks: {
                before: [
                  {
                    type: 'command',
                    cmd: 'rm -rf /',
                  },
                ],
              },
            },
          ],
        },
        null,
        2
      )
    );

    const result = await validateAndRepairAdf(filePath, 'pipeline-adf', { trustResolved: true });

    expect(result.repaired).toBe(false);
    expect(result.report).toContain('ADF guardrails failed');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it('uses the canonical repair path for an explicit execution step failure', async () => {
    const delegateTask = vi.fn(async (instruction: string) => {
      expect(instruction).toContain('## Failed Step');
      expect(instruction).toContain('demo:step');
      return JSON.stringify({ steps: [{ op: 'demo:step', params: {} }] });
    });
    registerFakeRepairBackend(delegateTask);
    const filePath = writeFixture(
      'execution-step-failure.json',
      JSON.stringify({ steps: [{ op: 'demo:step', params: {} }] }, null, 2)
    );

    const result = await validateAndRepairAdf(filePath, 'pipeline-adf', {
      trustResolved: true,
      step: { op: 'demo:step', id: 'failed-step', params: { value: 'before' } },
      failure: {
        category: 'runtime_error',
        detail: 'the demo actuator rejected the input',
        repairAction: 'repair the step parameters',
      },
    });

    expect(result.repaired).toBe(true);
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFixture(filePath))).toEqual({
      steps: [{ op: 'demo:step', params: {} }],
    });
  });

  it('blocks project-local pipeline repair without a trust decision', async () => {
    const filePath = writeFixture(
      'untrusted-pipeline.json',
      JSON.stringify({ steps: [{ op: 'demo:step', params: {} }] })
    );

    await expect(validateAndRepairAdf(filePath, 'pipeline-adf')).rejects.toThrow(
      '[TRUST_REQUIRED]'
    );
  });

  describe('KP-02: delegateTask knowledge context', () => {
    it('attaches a "Relevant knowledge" section to the delegation context when hints are found', async () => {
      vi.mocked(findRelevantDistilledKnowledge).mockResolvedValueOnce([
        {
          path: 'knowledge/product/evolution/distill_adf_example_2026-07-01.md',
          title: 'ADF repair example',
          tags: [],
          excerpt: 'A prior incident about capability-input schema violations.',
          score: 0.3,
        },
      ]);
      const delegateTask = vi.fn(async (_instruction: string, context?: string) => {
        expect(context).toContain('Relevant knowledge:');
        expect(context).toContain('ADF repair example');
        expect(context).toContain('knowledge/product/evolution/distill_adf_example_2026-07-01.md');
        return JSON.stringify({ capability: 'demo', action: 'run' });
      });
      registerFakeRepairBackend(delegateTask);
      const filePath = writeFixture(
        'schema-invalid-knowledge.json',
        JSON.stringify({ capability: 'demo' }, null, 2)
      );

      const result = await validateAndRepairAdf(filePath, 'capability-input');

      expect(result.repaired).toBe(true);
      expect(delegateTask).toHaveBeenCalledTimes(1);
    });

    it('fails open when knowledge retrieval throws — repair still delegates with the original context', async () => {
      vi.mocked(findRelevantDistilledKnowledge).mockRejectedValueOnce(new Error('boom'));
      const filePath = writeFixture(
        'schema-invalid-knowledge-fail.json',
        JSON.stringify({ capability: 'demo' }, null, 2)
      );
      const delegateTask = vi.fn(async (_instruction: string, context?: string) => {
        expect(context).toBe(`ADF Repair: ${filePath}`);
        return JSON.stringify({ capability: 'demo', action: 'run' });
      });
      registerFakeRepairBackend(delegateTask);

      const result = await validateAndRepairAdf(filePath, 'capability-input');

      expect(result.repaired).toBe(true);
      expect(delegateTask).toHaveBeenCalledTimes(1);
    });

    it('records knowledge delivery telemetry with a non-mission scope marker', async () => {
      vi.mocked(findRelevantDistilledKnowledge).mockResolvedValueOnce([
        {
          path: 'knowledge/product/evolution/distill_adf_delivery_2026-07-01.md',
          title: 'ADF repair delivery test doc',
          tags: [],
          excerpt: 'Delivery excerpt.',
          score: 0.5,
        },
      ]);
      const delegateTask = vi.fn(async () => JSON.stringify({ capability: 'demo', action: 'run' }));
      registerFakeRepairBackend(delegateTask);
      const filePath = writeFixture(
        'schema-invalid-delivery.json',
        JSON.stringify({ capability: 'demo' }, null, 2)
      );

      await validateAndRepairAdf(filePath, 'capability-input');

      const dir = knowledgeDeliveryLogDir();
      expect(safeExistsSync(dir)).toBe(true);
      const files = safeReaddir(dir).filter((name) => name.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);
      const raw = String(
        safeReadFile(pathResolver.rootResolve(`${dir}/${files[0]}`), { encoding: 'utf8' })
      );
      const records = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const record = records.find((entry) => entry.task_id === filePath);
      expect(record).toMatchObject({
        mission_id: 'adf-repair:capability-input',
        task_id: filePath,
        recipient_kind: 'adf_repair_agent',
      });
      expect(record.refs).toContainEqual(
        expect.objectContaining({
          path: 'knowledge/product/evolution/distill_adf_delivery_2026-07-01.md',
          title: 'ADF repair delivery test doc',
        })
      );
    });
  });
});
