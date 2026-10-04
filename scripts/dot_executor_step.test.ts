import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';
import { safeRmSync } from '@agent/core/secure-io';
import {
  stubReasoningBackend,
  type ReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import {
  DOT_EXECUTOR_DELEGATE_OPTIONS,
  DOT_EXECUTOR_SUPERVISOR_STEP,
  buildDotExecutorPorts,
  delegateDotText,
  runDotExecutorStep,
} from './dot_executor_step.js';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';
import { isDotExecutorPreEffectError } from '@agent/core/dot/dot-executor';

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
  safeRmSync('active/shared/tmp/dot-executor-step-tests', { recursive: true, force: true });
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
    expect(goalDriver).toHaveBeenCalledWith(expect.objectContaining({ objective: 'x' }));
    // An observer over the resolved backend: data members read through, every
    // method is an explicit wrapper (never inherited through a prototype).
    const passed = (goalDriver.mock.calls[0] as unknown as [{ backend: ReasoningBackend }])[0]
      .backend;
    expect(passed.name).toBe(toolBackend.name);
    expect(passed.divergePersonas).not.toBe(toolBackend.divergePersonas);
    expect(passed.divergePersonas).toBe(passed.divergePersonas);
    expect(result.finalText).toBe('did it');
  });

  it('classifies a goal driver that threw before any model call as a pre-effect failure', async () => {
    const early = vi.fn(async () => {
      throw new Error('driver config invalid');
    });
    const ports = buildDotExecutorPorts(CHARTER, {
      backend: toolBackend,
      goalDriver: early as never,
    });
    const error = await ports.runGoalTurn({ objective: 'x' }).catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(error)).toBe(true);
    expect(String(error)).toMatch(/before its first model call: driver config invalid/);

    const late = vi.fn(async (options: { backend: ReasoningBackend }) => {
      await options.backend.generateWithTools?.([] as never, [] as never);
      throw new Error('crashed mid-turn');
    });
    const midTurn = buildDotExecutorPorts(CHARTER, {
      backend: toolBackend,
      goalDriver: late as never,
    });
    const uncertain = await midTurn.runGoalTurn({ objective: 'x' }).catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(uncertain)).toBe(false);
    expect(String(uncertain)).toMatch(/crashed mid-turn/);

    // Non-model members do not count as a model call; model calls keep `this`.
    const thisSeen: unknown[] = [];
    const bound: ReasoningBackend = {
      ...toolBackend,
      generateWithTools: async function (this: unknown) {
        thisSeen.push(this);
        return { text: '', toolCalls: [] } as never;
      },
    };
    const readsOnly = vi.fn(async (options: { backend: ReasoningBackend }) => {
      void options.backend.name;
      options.backend.getRuntimeInstructions?.();
      throw new Error('gave up before the model');
    });
    const before = await buildDotExecutorPorts(CHARTER, {
      backend: bound,
      goalDriver: readsOnly as never,
    })
      .runGoalTurn({ objective: 'x' })
      .catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(before)).toBe(true);
    const calls = vi.fn(async (options: { backend: ReasoningBackend }) => {
      await options.backend.generateWithTools?.([] as never, [] as never);
      throw new Error('after the model');
    });
    const after = await buildDotExecutorPorts(CHARTER, {
      backend: bound,
      goalDriver: calls as never,
    })
      .runGoalTurn({ objective: 'x' })
      .catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(after)).toBe(false);
    expect(thisSeen).toEqual([bound]);
  });

  it('fails closed: a backend member outside the non-model denylist counts as a model call', async () => {
    const thisSeen: unknown[] = [];
    const backend: ReasoningBackend = {
      ...toolBackend,
      divergePersonas: async function (this: unknown) {
        thisSeen.push(this);
        return [];
      },
    };
    const metadataOnly = vi.fn(async (options: { backend: ReasoningBackend }) => {
      options.backend.getRuntimeProviderName?.();
      options.backend.requiresNativeSubagent?.();
      await options.backend.resetSession?.();
      throw new Error('gave up before the model');
    });
    const before = await buildDotExecutorPorts(CHARTER, {
      backend,
      goalDriver: metadataOnly as never,
    })
      .runGoalTurn({ objective: 'x' })
      .catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(before)).toBe(true);

    // divergePersonas is not on any allowlist: reaching it means the failure is
    // uncertain (quarantined), never retried as pre-effect.
    const unlisted = vi.fn(async (options: { backend: ReasoningBackend }) => {
      await options.backend.divergePersonas({} as never);
      throw new Error('crashed after diverging');
    });
    const uncertain = await buildDotExecutorPorts(CHARTER, {
      backend,
      goalDriver: unlisted as never,
    })
      .runGoalTurn({ objective: 'x' })
      .catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(uncertain)).toBe(false);
    expect(String(uncertain)).toMatch(/crashed after diverging/);
    expect(thisSeen).toEqual([backend]);
  });

  it('classifies a missing pipeline as a pre-effect failure before any step runs', async () => {
    const ports = buildDotExecutorPorts(CHARTER, { backend: textBackend });
    const error = await ports
      .runPipeline('pipelines/dot-executor-step-missing.json', {})
      .catch((e: unknown) => e);
    expect(isDotExecutorPreEffectError(error)).toBe(true);
    expect(String(error)).toMatch(/could not be loaded/);
  });

  it('uses a bounded delegated turn when no live tool candidate exists', async () => {
    const ports = buildDotExecutorPorts(CHARTER, { backend: textBackend });
    expect(ports.goalMode?.(CHARTER)).toBe('delegated');
    await expect(ports.delegateText('hello', 5_000)).resolves.toBe('answer to 5 chars');
    const hanging = { ...textBackend, delegateTask: () => new Promise<string>(() => {}) };
    await expect(delegateDotText(hanging, 'p', 10)).rejects.toThrow(/wall_clock budget 10ms/);
  });

  it('requests advisory + planner behavior on delegateTask and delegateTaskHandle', async () => {
    const delegateTask = vi.fn(async () => 'ok');
    await delegateDotText({ ...textBackend, delegateTask }, 'p', 5_000);
    expect(DOT_EXECUTOR_DELEGATE_OPTIONS).toEqual({ advisory: true, profile: 'planner' });
    expect(delegateTask).toHaveBeenCalledWith(
      'p',
      undefined,
      expect.objectContaining({ advisory: true, profile: 'planner' })
    );
    const handle = { join: vi.fn(async () => 'ok'), cancel: vi.fn(async () => {}) };
    const delegateTaskHandle = vi.fn(() => handle as never);
    await delegateDotText({ ...textBackend, delegateTaskHandle }, 'p', 5_000);
    expect(delegateTaskHandle).toHaveBeenCalledWith(
      'p',
      undefined,
      expect.objectContaining({ advisory: true, profile: 'planner' })
    );
  });

  it('cancels the delegated turn when the executor deadline aborts', async () => {
    const handle = {
      join: () => new Promise<string>(() => {}),
      cancel: vi.fn(async () => {}),
    };
    const controller = new AbortController();
    const pending = delegateDotText(
      { ...textBackend, delegateTaskHandle: () => handle as never },
      'p',
      60_000,
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted by the executor deadline/);
    expect(handle.cancel).toHaveBeenCalledTimes(1);
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
  it.each([toolBackend, textBackend])(
    'refuses task_session work with the $name adapter instead of claiming a text-only completion',
    async (backend) => {
      const goalDriver = vi.fn(async () => ({
        goalId: 'g',
        finalState: 'complete',
        goal: {},
        turnsRun: 1,
        rewindCount: 0,
        persisted: null,
        finalReport: 'claimed to have made the change',
      }));
      const target = {
        item_id: 'unsupported',
        title: 'Change a file',
        description: 'Apply the change',
        status: 'ready',
        version: 1,
        created_at: '2026-10-04T09:00:00Z',
        metadata: {
          dot_id: 'step-dot',
          action_ref: 'dact-task',
          requested_work_shape: 'task_session',
        },
      } as unknown as WorkItem;
      const release = vi.fn(() => ({ item: target, lease: {} as never }));
      const appendInbox = vi.fn();
      const rows = await runDotExecutorStep(
        new Date('2026-10-04T10:00:00Z'),
        [{ path: 'dots/step-dot.json', charter: CHARTER }],
        {
          rootDir: 'active/shared/tmp/dot-executor-step-tests',
          backend,
          goalDriver: goalDriver as never,
          listItems: () => [target],
          claim: () => ({ item: target, lease: { lease_id: 'l1' } as never }),
          release,
          throttle: () => 'normal',
          tokenCapReached: () => false,
          reap: () => ({ expired: [], recovered: [], parked: [], replayed: [] }),
          appendInbox,
          audit: () => {},
        }
      );
      expect(rows).toMatchObject([
        {
          status: 'blocked',
          mode: 'escalated',
          reason_code: 'capability_unavailable',
          report_suppressed: 'capability_unavailable',
          summary: expect.stringContaining('no governed task-session executor'),
        },
      ]);
      expect(goalDriver).not.toHaveBeenCalled();
      // Capability-unavailable results never wake the dot (no report-back inbox row).
      expect(appendInbox).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'archived' }));
    }
  );

  it('preserves a legitimate advisory direct reply through the real adapter', async () => {
    const goalDriver = vi.fn(async () => ({
      goalId: 'g',
      finalState: 'complete',
      goal: {},
      turnsRun: 1,
      rewindCount: 0,
      persisted: null,
      finalReport: 'Here is the explanation.',
    }));
    const target = {
      item_id: 'reply',
      title: 'Explain the result',
      description: 'Give an explanation',
      status: 'ready',
      version: 1,
      created_at: '2026-10-04T09:00:00Z',
      metadata: {
        dot_id: 'step-dot',
        action_ref: 'dact-reply',
        requested_work_shape: 'direct_reply',
      },
    } as unknown as WorkItem;
    const rows = await runDotExecutorStep(
      new Date('2026-10-04T10:00:00Z'),
      [{ path: 'dots/step-dot.json', charter: CHARTER }],
      {
        rootDir: 'active/shared/tmp/dot-executor-step-tests',
        backend: toolBackend,
        goalDriver: goalDriver as never,
        listItems: () => [target],
        claim: () => ({ item: target, lease: { lease_id: 'l1' } as never }),
        release: () => ({ item: target, lease: {} as never }),
        throttle: () => 'normal',
        tokenCapReached: () => false,
        reap: () => ({ expired: [], recovered: [], parked: [], replayed: [] }),
        appendInbox: () => {},
        audit: () => {},
      }
    );
    expect(rows).toMatchObject([
      {
        status: 'done',
        summary: expect.stringContaining('advisory result, effects are unverified'),
      },
    ]);
    expect(goalDriver).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining('You run read-only') })
    );
  });

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
        tokenCapReached: () => false,
        reap: () => ({ expired: [], recovered: [], parked: [], replayed: [] }),
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
