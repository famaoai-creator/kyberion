import { logger, safeReadFile, safeWriteFile, safeExec, safeExistsSync, safeUnlinkSync, derivePipelineStatus, pathResolver, determineActuatorStepType, classifyError, getReasoningBackend } from '@agent/core';
import * as path from 'node:path';

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

export async function executeSuperPipeline(input: SuperPipelineStep[] | A2AMessage, initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  
  let steps: SuperPipelineStep[];
  let conversationCtx: any = { ...initialCtx };

  if ('header' in input && 'payload' in input) {
    logger.info(`📬 [A2A] Incoming ${input.header.performative} from ${input.header.sender}`);
    conversationCtx = { ...conversationCtx, _a2a_header: input.header, conversation_id: input.header.conversation_id };
    if (input.payload.intent) {
      const { resolveIntentToSteps } = await import('./resolver.js');
      steps = await resolveIntentToSteps(input.payload.intent);
      conversationCtx = { ...conversationCtx, ...input.payload.context };
    } else {
      steps = input.payload.steps || [];
    }
  } else {
    steps = input as SuperPipelineStep[];
  }

  let ctx = { ...conversationCtx, timestamp: new Date().toISOString() };
  const results = [];

  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SUPER_NERVE] Exceeded max steps (${MAX_STEPS})`);
    
    logger.info(`  [NERVE] [Step ${state.stepCount}] Executing ${step.op}...`);
    
    let attempt = 0;
    while (attempt < 2) { // Allow 1 retry after repair
      try {
        const [domain, action] = step.op.split(':');
        
        if (domain === 'core') {
          // Handle core actions and update local context
          ctx = await handleCoreAction(action, step.params, ctx, options, state);
        } else {
          // Dispatch to actuators and update local context with result
          ctx = await dispatchToActuator(domain, action, step.params, ctx);
        }
        results.push({ op: step.op, status: 'success' });
        break; // Success, exit attempt loop
      } catch (err: any) {
        const failure = classifyError(err);
        if (attempt === 0 && failure.repairAction) {
          logger.warn(`  [NERVE] Step failed: ${failure.label}. Attempting autonomous repair...`);
          const repaired = await attemptAutonomousRepair(step, failure, ctx);
          if (repaired) {
            logger.success(`  [NERVE] Repair successful. Retrying step ${step.op}...`);
            attempt++;
            continue; // Retry once
          }
        }
        
        logger.error(`  [NERVE] Step failed (${step.op}): ${err.message}`);
        results.push({ op: step.op, status: 'failed', error: err.message });
        return { status: derivePipelineStatus(results), results, context: ctx }; // Abort on final failure
      }
    }
  }

  return { status: derivePipelineStatus(results), results, context: ctx };
}

async function attemptAutonomousRepair(step: SuperPipelineStep, failure: any, ctx: any): Promise<boolean> {
  try {
    const backend = getReasoningBackend();
    const instruction = `
The following pipeline step failed in Kyberion:
Step Operation: ${step.op}
Step Params: ${JSON.stringify(step.params)}
Error Category: ${failure.category}
Error Detail: ${failure.detail}

Repair Action Hint: ${failure.repairAction}

Your Task:
Perform the necessary actions (file edits, config updates, etc.) to repair this failure so the step can be retried successfully.
Assume the persona of a "Self-Healing SRE Agent".
Once finished, provide a brief summary of what you fixed.
`.trim();

    const report = await backend.delegateTask(instruction, `Self-Healing Mission for ${step.op}`);
    logger.info(`  [NERVE:REPAIR] Sub-agent report: ${report}`);
    return true; // Assume success if delegateTask completed without crashing
  } catch (err: any) {
    logger.error(`  [NERVE:REPAIR] Failed to perform repair: ${err.message}`);
    return false;
  }
}

async function handleCoreAction(action: string, params: any, ctx: any, options: any, state: any): Promise<any> {
  switch (action) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executeSuperPipeline(params.then, ctx, options, state);
        return res.context;
      } else if (params.else) {
        const res = await executeSuperPipeline(params.else, ctx, options, state);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      let currentCtx = ctx;
      while (evaluateCondition(params.condition, currentCtx) && iterations < maxIter) {
        const res = await executeSuperPipeline(params.pipeline, currentCtx, options, state);
        currentCtx = res.context;
        iterations++;
      }
      return currentCtx;

    case 'call':
      const macroPath = pathResolver.rootResolve(resolveVars(params.path, ctx));
      const macroDef = JSON.parse(safeReadFile(macroPath, { encoding: 'utf8' }) as string);
      const res = await executeSuperPipeline(macroDef.steps || [], ctx, options, state);
      return res.context;

    case 'set':
      return { ...ctx, [params.export_as]: resolveVars(params.value, ctx) };

    default:
      throw new Error(`Unknown core action: ${action}`);
  }
}

function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;
  const parts = cond.from.split('.');
  let val = ctx;
  for (const part of parts) { val = val?.[part]; }
  switch (cond.operator) {
    case 'exists': return val !== undefined && val !== null;
    case 'not_empty': return Array.isArray(val) ? val.length > 0 : !!val;
    case 'eq': return val === cond.value;
    case 'gt': return Number(val) > cond.value;
    default: return !!val;
  }
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
      const output = safeExec('node', ['dist/scripts/run_baseline_check.js'], { cwd: rootDir, timeoutMs: 120000 });
      const trimmed = output.trim();
      if (params?.export_as && typeof params.export_as === 'string') {
        return { ...ctx, [params.export_as]: trimmed };
      }
      return { ...ctx, pulse_status: trimmed };
    }
  }

  // Dynamic domain resolution via pathResolver
  let actuatorId = domain.endsWith('-actuator') ? domain : `${domain}-actuator`;
  let builtActuatorPath = pathResolver.capabilityEntry(actuatorId);

  if (!safeExistsSync(builtActuatorPath)) {
    // Try without -actuator suffix if direct ID was provided but doesn't follow convention
    if (safeExistsSync(pathResolver.capabilityEntry(domain))) {
      actuatorId = domain;
      builtActuatorPath = pathResolver.capabilityEntry(actuatorId);
    } else {
      throw new Error(`Unknown actuator domain: ${domain}. Built actuator not found at ${builtActuatorPath}. Run pnpm build first.`);
    }
  }

  const tempAdfPath = pathResolver.sharedTmp(
    `actuators/orchestrator-actuator/nerve-dispatch-${Date.now()}-${Math.random().toString(36).substring(7)}.json`
  );
  const outCtxPath = tempAdfPath.replace('.json', '-out.json');

  const adf = {
    action: 'pipeline',
    context: { ...ctx, context_path: path.relative(rootDir, outCtxPath) }, 
    steps: [{ type: determineActuatorStepType(domain, action), op: action, params: params }]
  };

  safeWriteFile(tempAdfPath, JSON.stringify(adf));

  try {
    safeExec('node', [builtActuatorPath, '--input', tempAdfPath]);
    
    if (safeExistsSync(outCtxPath)) {
      const resultData = JSON.parse(safeReadFile(outCtxPath, { encoding: 'utf8' }) as string);
      
      // Merge results from child into parent results if necessary?
      // For now, just ensure context is merged.
      
      if (resultData.results && resultData.results.some((r: any) => r.status === 'failed')) {
        const failedStep = resultData.results.find((r: any) => r.status === 'failed');
        throw new Error(`Actuator Execution Failed (${domain}:${action}): ${failedStep.error || 'Unknown error'}`);
      }

      const { context_path, results, status, total_steps, ...dataToMerge } = resultData;
      return { ...ctx, ...dataToMerge };
    }
    return ctx;
  } finally {
    if (safeExistsSync(tempAdfPath)) safeUnlinkSync(tempAdfPath);
    if (safeExistsSync(outCtxPath)) safeUnlinkSync(outCtxPath);
  }
}

function resolveVars(val: any, ctx: any): any {
  if (typeof val !== 'string') return val;
  const singleVarMatch = val.match(/^{{(.*?)}}$/);
  if (singleVarMatch) {
    const parts = singleVarMatch[1].trim().split('.');
    let current = ctx;
    for (const part of parts) { current = current?.[part]; }
    return current !== undefined ? current : '';
  }
  return val.replace(/{{(.*?)}}/g, (_, p) => {
    const parts = p.trim().split('.');
    let current = ctx;
    for (const part of parts) { current = current?.[part]; }
    return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
  });
}
