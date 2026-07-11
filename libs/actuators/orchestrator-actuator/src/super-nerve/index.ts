import {
  attemptAutonomousRepair,
  classifyError,
  determineActuatorStepType,
  evaluateCondition,
  executeAdfSteps,
  logger,
  pathResolver,
  resolveVars,
  skipAdfStep,
  safeExistsSync,
  safeExec,
  safeReadFile,
  suggestClosestStrings,
} from '@agent/core';
import { pathToFileURL } from 'node:url';

/**
 * Super-Nerve Engine v2.2.1 [FLOW REPAIRED]
 * Unified routing and control flow for the Kyberion ecosystem.
 */

export interface SuperPipelineStep {
  op: string;
  params: any;
  id?: string;
}

export interface A2AMessage {
  a2a_version: string;
  header: {
    msg_id: string;
    parent_id?: string;
    sender: string;
    receiver?: string;
    conversation_id?: string;
    performative: 'request' | 'propose' | 'inform' | 'accept' | 'reject' | 'query' | 'result';
    timestamp?: string;
    signature?: string;
  };
  payload: any;
}

export async function executeSuperPipeline(
  input: SuperPipelineStep[] | A2AMessage,
  initialCtx: any = {},
  options: any = {},
  state: any = { stepCount: 0, startTime: Date.now() }
) {
  const rootDir = pathResolver.rootDir();
  const maxSteps = options.max_steps || 1000;
  const timeoutMs = options.timeout_ms || 60000;

  let steps: SuperPipelineStep[];
  let conversationCtx: any = { ...initialCtx };

  if ('header' in input && 'payload' in input) {
    logger.info(`📬 [A2A] Incoming ${input.header.performative} from ${input.header.sender}`);
    conversationCtx = {
      ...conversationCtx,
      _a2a_header: input.header,
      conversation_id: input.header.conversation_id,
    };
    if (input.payload.intent) {
      const { resolveIntentToSteps } = await import('./resolver.js');
      steps = await resolveIntentToSteps(input.payload.intent, input.payload.context || {});
      conversationCtx = { ...conversationCtx, ...input.payload.context };
    } else {
      steps = input.payload.steps || [];
    }
  } else {
    steps = input as SuperPipelineStep[];
  }

  const initial = {
    ...conversationCtx,
    timestamp: new Date().toISOString(),
  };
  const normalizedSteps = steps.map(normalizeStep);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await executeAdfSteps(
      normalizedSteps,
      initial,
      { maxSteps: maxSteps - state.stepCount, timeoutMs },
      {
        capture: async (_op, _params, ctx) => ctx,
        transform: async (_op, _params, ctx) => ctx,
        apply: async (op, params, ctx) => {
          const [domain, action] = op.split(':');
          return await dispatchToActuator(domain, action, params, ctx);
        },
        control: async (op, params, ctx, runSteps) => {
          return await handleCoreAction(op, params, ctx, runSteps);
        },
      }
    );

    state.stepCount += result.total_steps;
    if (state.stepCount > maxSteps) {
      throw new Error(`[SUPER_NERVE] Exceeded max steps (${maxSteps})`);
    }
    if (result.status === 'succeeded') {
      return result;
    }

    const failed = result.results.find((entry) => entry.status === 'failed');
    if (!failed) {
      return result;
    }

    const failure = classifyError(new Error(failed.error || `Step failed: ${failed.op}`));
    if (attempt === 0 && failure.repairAction) {
      logger.warn(`  [NERVE] Step failed: ${failure.label}. Attempting autonomous repair...`);
      const failedStep = normalizedSteps.find((step) => step.op === failed.op) ||
        steps[0] || { op: failed.op, params: {} };
      const repaired = await attemptAutonomousRepair({
        step: { op: failedStep.op, params: failedStep.params },
        failure,
        logPrefix: '[NERVE:REPAIR]',
      });
      if (repaired) {
        logger.success(`  [NERVE] Repair successful. Retrying pipeline...`);
        continue;
      }
    }

    return result;
  }

  throw new Error(`[SUPER_NERVE] Exhausted repair attempts`);
}

function normalizeStep(step: SuperPipelineStep) {
  const [domain, action] = step.op.split(':');
  if (domain === 'core') {
    return { type: 'control' as const, op: action, params: step.params };
  }
  return { type: 'apply' as const, op: `${domain}:${action}`, params: step.params };
}

function normalizeNestedSteps(
  steps: any[]
): Array<{ type: 'capture' | 'transform' | 'apply' | 'control'; op: string; params: any }> {
  return Array.isArray(steps) ? steps.map((step) => normalizeStep(step)) : [];
}

async function handleCoreAction(
  action: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>
): Promise<any> {
  switch (action) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const nested = await runSteps(normalizeNestedSteps(params.then), ctx);
        if (nested.status === 'failed') {
          throw new Error(
            nested.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        return nested.context;
      } else if (params.else) {
        const nested = await runSteps(normalizeNestedSteps(params.else), ctx);
        if (nested.status === 'failed') {
          throw new Error(
            nested.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        return nested.context;
      }
      return skipAdfStep(
        ctx,
        'core:if condition evaluated to false and no else branch was provided'
      );

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      let currentCtx = ctx;
      let executed = false;
      while (evaluateCondition(params.condition, currentCtx) && iterations < maxIter) {
        executed = true;
        const nested = await runSteps(normalizeNestedSteps(params.pipeline), currentCtx);
        if (nested.status === 'failed') {
          throw new Error(
            nested.results.find((result: any) => result.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        currentCtx = nested.context;
        iterations += 1;
      }
      return executed
        ? currentCtx
        : skipAdfStep(ctx, 'core:while condition evaluated to false before execution');
    }

    case 'call':
    case 'include': {
      const ref = String(resolveVars(params.path ?? params.fragment ?? '', ctx));
      const macroPath = pathResolver.rootResolve(ref);
      const macroDef = JSON.parse(safeReadFile(macroPath, { encoding: 'utf8' }) as string);
      const nested = await runSteps(normalizeNestedSteps(macroDef.steps || []), ctx);
      if (nested.status === 'failed') {
        throw new Error(
          nested.results.find((result: any) => result.status === 'failed')?.error ||
            'nested pipeline failed'
        );
      }
      return nested.context;
    }

    case 'set':
      return { ...ctx, [params.export_as]: resolveVars(params.value, ctx) };

    default:
      throw new Error(buildUnknownCoreActionMessage(action));
  }
}

function buildUnknownCoreActionMessage(action: string): string {
  const suggestions = suggestClosestStrings(action, ['if', 'while', 'call', 'include', 'set']);
  return suggestions.length > 0
    ? `Unknown core action: ${action}. Did you mean: ${suggestions.join(', ')}?`
    : `Unknown core action: ${action}`;
}

async function dispatchToActuator(domain: string, action: string, params: any, ctx: any) {
  const rootDir = pathResolver.rootDir();
  if (domain === 'system') {
    if (action === 'shell') {
      const cmd = resolveVars(params?.cmd, ctx);
      if (!cmd || typeof cmd !== 'string') return ctx;
      const output = safeExec('zsh', ['-lc', cmd], { cwd: rootDir, timeoutMs: 120000 });
      if (params?.export_as && typeof params.export_as === 'string') {
        return { ...ctx, [params.export_as]: output.trim() };
      }
      return ctx;
    }
  }

  if (action === 'log' || action === 'pulse_status') {
    if (action === 'log') {
      if (params?.message) logger.info(String(resolveVars(params.message, ctx)));
      return ctx;
    }
    if (action === 'pulse_status') {
      const output = safeExec('node', ['dist/scripts/run_baseline_check.js'], {
        cwd: rootDir,
        timeoutMs: 120000,
      });
      const trimmed = output.trim();
      if (params?.export_as && typeof params.export_as === 'string') {
        return { ...ctx, [params.export_as]: trimmed };
      }
      return { ...ctx, pulse_status: trimmed };
    }
  }

  let actuatorId = domain.endsWith('-actuator') ? domain : `${domain}-actuator`;
  let builtActuatorPath = pathResolver.capabilityEntry(actuatorId);

  if (!safeExistsSync(builtActuatorPath)) {
    if (safeExistsSync(pathResolver.capabilityEntry(domain))) {
      actuatorId = domain;
      builtActuatorPath = pathResolver.capabilityEntry(actuatorId);
    } else {
      throw new Error(
        `Unknown actuator domain: ${domain}. Built actuator not found at ${builtActuatorPath}. Run pnpm build first.`
      );
    }
  }

  // AR-01 Task 3: dispatch in-process. The old path spawned `node <entry>
  // --input tmp.json` per op and round-tripped context through a temp file —
  // a performance sink and a divergence from run_pipeline's in-process
  // dispatch. Import the built entry once (cached) and call its pipeline
  // handler directly; the handler returns { status, results, context }.
  const mod = await actuatorModuleLoader.load(builtActuatorPath);
  if (typeof mod.handleAction !== 'function') {
    throw new Error(`Actuator ${actuatorId} does not expose handleAction (${builtActuatorPath})`);
  }
  const resultData = await mod.handleAction({
    action: 'pipeline',
    context: { ...ctx },
    steps: [{ type: determineActuatorStepType(domain, action), op: action, params: params }],
  });

  if (
    resultData?.results &&
    Array.isArray(resultData.results) &&
    resultData.results.some((r: any) => r.status === 'failed')
  ) {
    const failedStep = resultData.results.find((r: any) => r.status === 'failed');
    throw new Error(
      `Actuator Execution Failed (${domain}:${action}): ${failedStep.error || 'Unknown error'}`
    );
  }

  const finalCtx =
    resultData &&
    typeof resultData === 'object' &&
    resultData.context &&
    typeof resultData.context === 'object'
      ? (resultData.context as Record<string, any>)
      : {};
  const { context_path: _contextPath, ...dataToMerge } = finalCtx;
  return { ...ctx, ...dataToMerge };
}

// Seam for tests and future loaders: resolves a built actuator entry to its
// module. Cached per entry path so repeated ops don't re-import.
export const actuatorModuleLoader = {
  cache: {} as Record<string, any>,
  async load(entryPath: string): Promise<any> {
    if (!this.cache[entryPath]) {
      this.cache[entryPath] = await import(pathToFileURL(entryPath).href);
    }
    return this.cache[entryPath];
  },
};
