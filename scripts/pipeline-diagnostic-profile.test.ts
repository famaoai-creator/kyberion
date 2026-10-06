import { getDefaultWorkerEventStream } from '@agent/core/workforce/worker-event-stream';
import { TraceContext } from '@agent/core/trace';
import { registerScenarioOpOverride } from '@agent/core/actuator/actuator-op-registry';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as reasoning from '@agent/core/reasoning/reasoning-backend';
import { getDefaultLifecycleHookEngine } from '@agent/core/lifecycle-hook-engine';
import {
  registerOpPreflightListener,
  registerOpGuard,
  registerOpPreflightOutcomeObserver,
  resetOpPreflight,
} from '@agent/core/pipeline/op-preflight';
import { assertBuiltinOnlyOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { FRONT_DESK_RECEIPT_PIPELINE } from '@agent/core/surface/front-desk-execution-contract';

const calls = vi.hoisted(() => ({
  repair: vi.fn(() => {
    throw new Error('repair must not run');
  }),
  classify: vi.fn(() => {
    throw new Error('model classification must not run');
  }),
  bootstrap: vi.fn(() => {
    throw new Error('provider bootstrap must not run');
  }),
  feedback: vi.fn(),
}));
vi.mock('@agent/core/autonomous-repair', () => ({ attemptAutonomousRepair: calls.repair }));
vi.mock('@agent/core/error-classifier-judgment', () => ({
  refineErrorClassification: calls.classify,
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: calls.bootstrap,
}));
vi.mock('@agent/core/feedback-loop', () => ({ runFeedbackLoop: calls.feedback }));

import * as bootstrap from './pipeline-execution-part-bootstrap.js';
import { executePipelineFile, runValidatedSteps } from './pipeline-execution-part-results.js';
import { runWithRepair } from './pipeline-execution-part-execution.js';
import { assertDiagnosticPipelineProfile } from './pipeline-diagnostic-profile.js';

const ROOT = 'active/shared/tmp/pipeline-diagnostic-profile-tests';
const context = () => ({
  front_desk_output_path: ROOT + '/receipt.json',
  front_desk_artifact_content: 'local receipt',
});
const steps = () => [
  {
    id: 'write-request-receipt',
    role: 'sink' as const,
    op: 'system:write_file',
    params: { path: '{{front_desk_output_path}}', content: '{{front_desk_artifact_content}}' },
  },
];
const disposers: Array<() => void> = [];
let getBackend: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetOpPreflight();
  vi.clearAllMocks();
  getBackend = vi.spyOn(reasoning, 'getReasoningBackend').mockImplementation(() => {
    throw new Error('provider resolution forbidden');
  });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  safeRmSync(ROOT, { recursive: true, force: true });
  resetOpPreflight();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function options(extra: Record<string, unknown> = {}) {
  return {
    executionMode: 'front_desk_diagnostic' as const,
    context: context(),
    quiet: true,
    hasHuman: false,
    validateLoadedPipeline: vi.fn((_pipeline: unknown, source: string) => {
      expect(source).toBe(
        safeReadFile(pathResolver.rootResolve(FRONT_DESK_RECEIPT_PIPELINE), { encoding: 'utf8' })
      );
    }),
    ...extra,
  };
}
function expectNoProviders() {
  expect(getBackend).not.toHaveBeenCalled();
  expect(calls.repair).not.toHaveBeenCalled();
  expect(calls.classify).not.toHaveBeenCalled();
  expect(calls.bootstrap).not.toHaveBeenCalled();
  expect(calls.feedback).not.toHaveBeenCalled();
}

describe('bounded diagnostic canonical pipeline', () => {
  it('persists local diagnostic traces without OTLP export while generic traces still export', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    const send = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const original = bootstrap.finalizePipelineTrace;
    const persist = vi
      .spyOn(bootstrap, 'finalizePipelineTrace')
      .mockImplementation((trace, recovered, opts) =>
        original(trace, recovered, { ...opts, dir: ROOT + '/traces' })
      );
    const result = await executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options());
    expect(result.status).toBe('succeeded');
    expect(persist).toHaveBeenCalledWith(expect.anything(), true, { localOnly: true });
    expect(safeExistsSync(result.persistedPath)).toBe(true);
    expect(safeReadFile(result.persistedPath, { encoding: 'utf8' })).toContain(
      'front-desk-request-receipt'
    );
    expect(send).not.toHaveBeenCalled();
    original(new TraceContext('generic-observability'), true, { dir: ROOT + '/generic-traces' });
    expect(send).toHaveBeenCalledOnce();
    expectNoProviders();
  });
  it.each(['initial', 'late'] as const)(
    'refuses %s opaque worker event subscribers without invoking them',
    async (timing) => {
      const listener = vi.fn();
      let checks = 0;
      if (timing === 'initial') disposers.push(getDefaultWorkerEventStream().subscribe(listener));
      const run = executePipelineFile(
        FRONT_DESK_RECEIPT_PIPELINE,
        options({
          validateLoadedPipeline: () => {
            if (++checks === 2 && timing === 'late')
              disposers.push(getDefaultWorkerEventStream().subscribe(listener));
          },
        })
      );
      await expect(run).rejects.toThrow('builtin-only worker event listeners');
      expect(listener).not.toHaveBeenCalled();
      expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
      expectNoProviders();
    }
  );
  it('rejects a scenario override before invoking its resolver, approval callback or handler', async () => {
    const handler = vi.fn();
    const resolve = vi.fn(() => ({ handler }));
    const approvalGranted = vi.fn(() => true);
    disposers.push(registerScenarioOpOverride({ resolve, approvalGranted }));
    await expect(executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options())).rejects.toThrow(
      'scenario overrides'
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(approvalGranted).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it('refuses unrelated ambient or explicit mission context without changing it', async () => {
    vi.stubEnv('MISSION_ID', 'MSN-UNRELATED-CONFIDENTIAL');
    await expect(executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options())).rejects.toThrow(
      'separate unbound diagnostic shell'
    );
    expect(process.env.MISSION_ID).toBe('MSN-UNRELATED-CONFIDENTIAL');
    vi.stubEnv('MISSION_ID', '');
    await expect(
      executePipelineFile(
        FRONT_DESK_RECEIPT_PIPELINE,
        options({ context: { ...context(), mission_id: 'MSN-OTHER' } })
      )
    ).rejects.toThrow('mission context');
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it('runs the exact write through validation/preflight and rechecks the approved loaded snapshot', async () => {
    const opts = options();
    const result = await executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, opts);
    expect(result.status).toBe('succeeded');
    expect(safeReadFile(context().front_desk_output_path, { encoding: 'utf8' })).toBe(
      'local receipt'
    );
    expect(opts.validateLoadedPipeline).toHaveBeenCalledTimes(2);
    expectNoProviders();
  });
  it('fails an ordinary write error once without classification, repair or feedback', async () => {
    safeMkdir(ROOT + '/directory', { recursive: true });
    const result = await executePipelineFile(
      FRONT_DESK_RECEIPT_PIPELINE,
      options({ context: { ...context(), front_desk_output_path: ROOT + '/directory' } })
    );
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('without automatic repair');
    expectNoProviders();
  });
  it('keeps builtin scope guards active and does not repair their refusal', async () => {
    const result = await executePipelineFile(
      FRONT_DESK_RECEIPT_PIPELINE,
      options({ context: { ...context(), scope_envelope: { invalid: true } } })
    );
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('OP_PREFLIGHT_BLOCK');
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it('does not auto-repair a typed-flow preflight failure', async () => {
    vi.spyOn(bootstrap, 'validateFlow').mockReturnValue([
      { stepIndex: 0, stepId: 'write-request-receipt', missing: ['required-input'] },
    ] as never);
    const result = await runValidatedSteps(steps(), context(), {
      executionMode: 'front_desk_diagnostic',
      pipelinePath: FRONT_DESK_RECEIPT_PIPELINE,
      quiet: true,
    });
    expect(result.status).toBe('failed');
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it('refuses broadened topology or absent snapshot binding before effects', async () => {
    expect(() =>
      assertDiagnosticPipelineProfile('front_desk_diagnostic', FRONT_DESK_RECEIPT_PIPELINE, [
        { ...steps()[0], hooks: { before: [{ op: 'system:exec' }] } },
      ] as never)
    ).toThrow();
    expect(() =>
      assertDiagnosticPipelineProfile('front_desk_diagnostic', 'pipelines/other.json', steps())
    ).toThrow();
    await expect(
      executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, { executionMode: 'front_desk_diagnostic' })
    ).rejects.toThrow('snapshot validator');
    const refuse = vi.fn(() => {
      throw new Error('approval snapshot digest changed');
    });
    await expect(
      executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options({ validateLoadedPipeline: refuse }))
    ).rejects.toThrow('digest changed');
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it.each(['session_start', 'pre_tool_use', 'post_tool_use_failure', 'task_settled'] as const)(
    'refuses %s extensions without calling or bypassing them',
    async (event) => {
      const handler = vi.fn(() => {
        throw new Error('unbounded hook invoked');
      });
      disposers.push(
        getDefaultLifecycleHookEngine().register({ id: 'diagnostic-hook-test', event, handler })
      );
      await expect(executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options())).rejects.toThrow(
        'DIAGNOSTIC_HOOKS_UNSUPPORTED'
      );
      expect(handler).not.toHaveBeenCalled();
      expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
      expectNoProviders();
    }
  );
  it.each(['listener', 'guard', 'observer'] as const)(
    'refuses custom operation %s before invoking it',
    async (kind) => {
      assertBuiltinOnlyOpPreflight();
      const callback = vi.fn();
      disposers.push(
        kind === 'listener'
          ? registerOpPreflightListener({ id: 'custom', run: callback })
          : kind === 'guard'
            ? registerOpGuard({ id: 'custom', check: callback })
            : registerOpPreflightOutcomeObserver(callback)
      );
      await expect(executePipelineFile(FRONT_DESK_RECEIPT_PIPELINE, options())).rejects.toThrow(
        'builtin-only operation preflight'
      );
      expect(callback).not.toHaveBeenCalled();
      expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
      expectNoProviders();
    }
  );
  it('rechecks live approval immediately before the write after awaited preflight', async () => {
    let checks = 0;
    const result = await executePipelineFile(
      FRONT_DESK_RECEIPT_PIPELINE,
      options({
        validateLoadedPipeline: () => {
          if (++checks > 1) throw new Error('charter paused');
        },
      })
    );
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('charter paused');
    expect(safeExistsSync(context().front_desk_output_path)).toBe(false);
    expectNoProviders();
  });
  it('the bounded repair adapter makes only one attempt', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('EACCES write refused');
    });
    await expect(
      runWithRepair(
        steps()[0],
        { executionMode: 'front_desk_diagnostic', pipelinePath: FRONT_DESK_RECEIPT_PIPELINE },
        {},
        attempt
      )
    ).rejects.toThrow('without automatic repair');
    expect(attempt).toHaveBeenCalledOnce();
    expectNoProviders();
  });
});
