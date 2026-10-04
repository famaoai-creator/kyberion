import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';
import {
  stubReasoningBackend,
  type ReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import {
  DOT_EXECUTOR_SUPERVISOR_STEP,
  buildDotExecutorPorts,
  delegateDotText,
  runDotExecutorStep,
} from './dot_executor_step.js';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'step-dot',
  version: '1.0.0',
  title: 'Step dot',
  purpose: 'p',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'g' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_pipelines: ['pipelines/ok.json'],
  },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-step-dot' },
};

const toolBackend: ReasoningBackend = {
  ...stubReasoningBackend,
  name: 'anthropic',
  generateWithTools: async () => ({ text: '', toolCalls: [] }) as never,
};
const textBackend: ReasoningBackend = {
  ...stubReasoningBackend,
  name: 'claude-cli',
  delegateTaskHandle: undefined,
  delegateTask: vi.fn(async (prompt: string) => `answer to ${prompt.length} chars`),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDotExecutorPorts', () => {
  it('drives the goal loop with the resolved tool backend and surfaces the final report', async () => {
    const goalDriver = vi.fn(async () => ({
      goalId: 'g',
      finalState: 'complete',
      goal: { terminalReason: 'reason' },
      turnsRun: 1,
      rewindCount: 0,
      persisted: null,
      finalReport: 'did it',
    }));
    const ports = buildDotExecutorPorts(CHARTER, {
      backend: toolBackend,
      goalDriver: goalDriver as never,
    });
    expect(ports.goalMode?.(CHARTER)).toBe('tool');
    const result = await ports.runGoalTurn({ objective: 'x', toolRole: 'infrastructure_sentinel' });
    expect(goalDriver).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'x', backend: toolBackend })
    );
    expect(result.finalText).toBe('did it');
  });

  it('uses a bounded delegated turn when no live tool candidate exists', async () => {
    const ports = buildDotExecutorPorts(CHARTER, { backend: textBackend });
    expect(ports.goalMode?.(CHARTER)).toBe('delegated');
    await expect(ports.delegateText('hello', 5_000)).resolves.toBe('answer to 5 chars');
    const hanging = { ...textBackend, delegateTask: () => new Promise<string>(() => {}) };
    await expect(delegateDotText(hanging, 'p', 10)).rejects.toThrow(/wall_clock budget 10ms/);
  });

  it('reports the process-default stub as unavailable (items stay unclaimed)', () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'claude-cli');
    const ports = buildDotExecutorPorts(CHARTER, {});
    expect(ports.goalMode?.(CHARTER)).toEqual({ unavailable: expect.any(String) });
  });

  it('passes pipeline work to the pipeline port with the charter', async () => {
    const executePipeline = vi.fn(async () => ({ status: 'succeeded' as const, summary: 'ok' }));
    const ports = buildDotExecutorPorts(CHARTER, { backend: textBackend, executePipeline });
    await ports.runPipeline('pipelines/ok.json', { dot_id: 'step-dot' });
    expect(executePipeline).toHaveBeenCalledWith(
      'pipelines/ok.json',
      { dot_id: 'step-dot' },
      CHARTER
    );
  });
});

describe('dot-executor supervisor step', () => {
  it('is registered after key-result measurement', () => {
    const ids = DOT_SUPERVISOR_STEPS.map((step) => step.id);
    expect(ids).toContain('dot-executor');
    expect(DOT_SUPERVISOR_STEPS).toContain(DOT_EXECUTOR_SUPERVISOR_STEP);
    if (ids.includes('dot-kr-measure')) {
      expect(ids.indexOf('dot-executor')).toBeGreaterThan(ids.indexOf('dot-kr-measure'));
    }
  });

  it('runs one sweep with real port wiring', async () => {
    const item = {
      item_id: 'w1',
      title: 'Run ok',
      description: 'run',
      status: 'ready',
      version: 1,
      created_at: '2026-10-04T09:00:00Z',
      metadata: {
        dot_id: 'step-dot',
        action_ref: 'dact-1',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    } as unknown as WorkItem;
    const executePipeline = vi.fn(async () => ({ status: 'succeeded' as const, summary: 'ok' }));
    const rows = await runDotExecutorStep(
      new Date('2026-10-04T10:00:00Z'),
      [{ path: 'dots/step-dot.json', charter: CHARTER }],
      {
        rootDir: 'active/shared/tmp/dot-executor-step-tests',
        backend: textBackend,
        executePipeline,
        listItems: () => [item],
        claim: () => ({ item, lease: { lease_id: 'l1' } as never }),
        release: () => ({ item, lease: {} as never }),
        throttle: () => 'normal',
        appendInbox: () => {},
        audit: () => {},
      }
    );
    expect(rows).toMatchObject([{ status: 'done', mode: 'pipeline' }]);
    expect(executePipeline).toHaveBeenCalledTimes(1);
    const { safeRmSync } = await import('@agent/core/secure-io');
    safeRmSync('active/shared/tmp/dot-executor-step-tests', { recursive: true, force: true });
  });
});
