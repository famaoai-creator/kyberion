import { logger, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Super-Nerve Engine: Cross-Actuator Orchestration & Composable Pipelines
 * This module routes 'op' commands to their respective underlying Actuator APIs.
 */

export interface SuperPipelineStep {
  op: string; // Format: "domain:action" (e.g., "file:read", "browser:goto", "core:call")
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

export async function executeSuperPipeline(input: SuperPipelineStep[] | A2AMessage, initialCtx: any = {}, options: any = {}) {
  const rootDir = process.cwd();
  const MAX_STEPS = options.max_steps || 1000;
  
  let steps: SuperPipelineStep[];
  let conversationCtx: any = { ...initialCtx };

  // 1. A2A Envelope Unwrapping
  if ('header' in input && 'payload' in input) {
    logger.info(`📬 [A2A] Incoming ${input.header.performative} from ${input.header.sender}`);
    conversationCtx = { 
      ...conversationCtx, 
      _a2a_header: input.header,
      conversation_id: input.header.conversation_id 
    };
    
    // If payload is an intent, resolve it
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
  let stepCount = 0;
  const results = [];

  for (const step of steps) {
    stepCount++;
    if (stepCount > MAX_STEPS) throw new Error(`[SUPER_NERVE] Exceeded max steps (${MAX_STEPS})`);
    
    logger.info(`  [NERVE] Executing ${step.op}...`);
    
    try {
      const [domain, action] = step.op.split(':');
      
      if (domain === 'core') {
        ctx = await handleCoreAction(action, step.params, ctx, options, stepCount);
      } else {
        ctx = await dispatchToActuator(domain, action, step.params, ctx);
      }
      
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [NERVE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      // Stop pipeline on failure
      break;
    }
  }

  return { status: 'finished', results, context: ctx };
}

async function handleCoreAction(action: string, params: any, ctx: any, options: any, stepCount: number) {
  if (action === 'call') {
    const macroPath = path.resolve(process.cwd(), resolveVars(params.path, ctx));
    if (!fs.existsSync(macroPath)) throw new Error(`Macro not found: ${macroPath}`);
    const macroDef = JSON.parse(safeReadFile(macroPath, { encoding: 'utf8' }) as string);
    const res = await executeSuperPipeline(macroDef.steps || [], ctx, options);
    return res.context;
  }
  
  if (action === 'set') {
    return { ...ctx, [params.export_as]: resolveVars(params.value, ctx) };
  }
  
  throw new Error(`Unknown core action: ${action}`);
}

async function dispatchToActuator(domain: string, action: string, params: any, ctx: any) {
  const domainMap: Record<string, string> = {
    'file': 'libs/actuators/file-actuator/src/index.ts',
    'system': 'libs/actuators/system-actuator/src/index.ts',
    'wisdom': 'libs/actuators/wisdom-actuator/src/index.ts',
    'network': 'libs/actuators/network-actuator/src/index.ts',
    'browser': 'libs/actuators/browser-actuator/src/index.ts',
    'code': 'libs/actuators/code-actuator/src/index.ts',
    'orchestrator': 'libs/actuators/orchestrator-actuator/src/index.ts'
  };

  const actuatorPath = domainMap[domain];
  if (!actuatorPath) throw new Error(`Unknown actuator domain: ${domain}`);

  const tempAdfPath = path.resolve(process.cwd(), `scratch/nerve-dispatch-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);
  const outCtxPath = tempAdfPath.replace('.json', '-out.json');

  const adf = {
    action: 'pipeline',
    context: { ...ctx, context_path: path.relative(process.cwd(), outCtxPath) }, 
    steps: [
      {
        type: determineType(domain, action),
        op: action,
        params: params
      }
    ]
  };

  safeWriteFile(tempAdfPath, JSON.stringify(adf));

  try {
    const out = safeExec('npx', ['tsx', actuatorPath, '--input', tempAdfPath]);
    
    // Forward logs
    out.split('\n').forEach(line => {
      if (line.trim()) console.log(`    [${domain}] ${line.trim()}`);
    });
    
    if (fs.existsSync(outCtxPath)) {
      const resultData = JSON.parse(safeReadFile(outCtxPath, { encoding: 'utf8' }) as string);
      
      // Check for failure in child actuator
      if (resultData.results && resultData.results.some((r: any) => r.status === 'failed')) {
        const failedStep = resultData.results.find((r: any) => r.status === 'failed');
        throw new Error(`Actuator Execution Failed (${domain}:${action}): ${failedStep.error || 'Unknown error'}`);
      }

      if (resultData.context) {
        const { context_path, ...dataToMerge } = resultData.context;
        return { ...ctx, ...dataToMerge };
      }
      return ctx;
    }
    return ctx;
  } finally {
    if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    if (fs.existsSync(outCtxPath)) fs.unlinkSync(outCtxPath);
  }
}

function determineType(domain: string, action: string): string {
  const captureOps = ['read', 'read_file', 'read_json', 'fetch', 'shell', 'list', 'glob_files', 'search', 'goto', 'content', 'evaluate', 'vision_consult', 'pulse_status', 'discover_skills'];
  const transformOps = ['regex_extract', 'regex_replace', 'json_query', 'run_js', 'yaml_update', 'json_parse', 'path_join', 'array_count', 'array_filter', 'variable_hydrate', 'json_update'];
  const applyOps = ['write', 'write_file', 'log', 'click', 'fill', 'press', 'wait', 'delete', 'mkdir', 'symlink', 'git_checkpoint', 'voice', 'notify', 'keyboard', 'mouse_click', 'deploy', 'append', 'copy', 'move'];
  
  if (captureOps.includes(action)) return 'capture';
  if (transformOps.includes(action)) return 'transform';
  if (applyOps.includes(action)) return 'apply';
  return 'apply';
}

function resolveVars(val: any, ctx: any): any {
  if (typeof val !== 'string') return val;
  return val.replace(/{{(.*?)}}/g, (_, p) => {
    const parts = p.trim().split('.');
    let current = ctx;
    for (const part of parts) { current = current?.[part]; }
    return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
  });
}
