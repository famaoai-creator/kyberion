import { logger } from './core.js';
import { isExternalEffectStep, type ServiceRecording, type ServiceRecordingStep } from './service-recording.js';

export type ServicePresetRunner = (serviceId: string, action: string, params: any) => Promise<any>;

export interface ServiceStepResult {
  step_id: string;
  service_id: string;
  action: string;
  status: 'done' | 'skipped' | 'blocked' | 'error';
  detail?: string;
  produced?: string;
}

export interface ExecuteServiceProcedureInput {
  recording: ServiceRecording;
  /** User-supplied values for `{{input.NAME}}` placeholders. */
  inputs?: Record<string, unknown>;
  /** True once the approval gate has granted the external-effect steps. */
  externalEffectApproved: boolean;
  /** Injected preset runner (defaults to the real service engine). Mockable for tests. */
  executePreset?: ServicePresetRunner;
  /** Dry-run: execute only read steps; never fire external effects. */
  dryRun?: boolean;
}

export interface ExecuteServiceProcedureResult {
  status: 'completed' | 'blocked' | 'failed';
  results: ServiceStepResult[];
  /** Channel outputs produced during the run (produces → result). */
  channels: Record<string, unknown>;
}

const INPUT_RE = /\{\{input\.([a-z][a-z0-9_]{0,63})\}\}/g;
const CHANNEL_RE = /\{\{channel\.([a-zA-Z0-9_]+)\}\}/g;

/** Resolve `{{input.X}}` / `{{channel.X}}` placeholders inside a params structure. */
export function resolveServiceParams(
  params: unknown,
  inputs: Record<string, unknown>,
  channels: Record<string, unknown>,
): unknown {
  if (typeof params === 'string') {
    // A string that is exactly one placeholder resolves to the raw value (keeps type).
    const inputExact = params.match(/^\{\{input\.([a-z][a-z0-9_]{0,63})\}\}$/);
    if (inputExact) return inputs[inputExact[1]] ?? '';
    const channelExact = params.match(/^\{\{channel\.([a-zA-Z0-9_]+)\}\}$/);
    if (channelExact) return channels[channelExact[1]] ?? '';
    return params
      .replace(INPUT_RE, (_m, n) => String(inputs[n] ?? ''))
      .replace(CHANNEL_RE, (_m, n) => String(channels[n] ?? ''));
  }
  if (Array.isArray(params)) return params.map((p) => resolveServiceParams(p, inputs, channels));
  if (params && typeof params === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) out[k] = resolveServiceParams(v, inputs, channels);
    return out;
  }
  return params;
}

async function defaultExecutePreset(serviceId: string, action: string, params: any): Promise<any> {
  const { executeServicePreset } = await import('./service-engine.js');
  return executeServicePreset(serviceId, action, params, 'secret-guard');
}

/**
 * Execute a service procedure: run each step via the preset runner, threading
 * `produces` → `consumes` through named channels. External-effect (high-risk)
 * steps require `externalEffectApproved` and are skipped in dry-run.
 *
 * Agent-S3 (Dispatcher/exec). Design: docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md §7-C
 */
export async function executeServiceProcedure(
  input: ExecuteServiceProcedureInput,
): Promise<ExecuteServiceProcedureResult> {
  const run = input.executePreset ?? defaultExecutePreset;
  const inputs = input.inputs ?? {};
  const channels: Record<string, unknown> = {};
  const results: ServiceStepResult[] = [];

  for (const step of input.recording.steps) {
    const external = isExternalEffectStep(step);
    if (external && input.dryRun) {
      results.push({ step_id: step.step_id, service_id: step.service_id, action: step.action, status: 'skipped', detail: 'dry-run: external-effect not fired' });
      continue;
    }
    if (external && !input.externalEffectApproved) {
      results.push({ step_id: step.step_id, service_id: step.service_id, action: step.action, status: 'blocked', detail: 'external-effect requires approval' });
      return { status: 'blocked', results, channels };
    }
    const resolved = resolveServiceParams(step.params ?? {}, inputs, channels) as Record<string, unknown>;
    try {
      const result = await run(step.service_id, step.action, resolved);
      if (step.produces) channels[step.produces] = result;
      results.push({ step_id: step.step_id, service_id: step.service_id, action: step.action, status: 'done', produced: step.produces });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`[service-procedure-executor] step ${step.step_id} (${step.service_id}.${step.action}) failed: ${detail}`);
      results.push({ step_id: step.step_id, service_id: step.service_id, action: step.action, status: 'error', detail });
      return { status: 'failed', results, channels };
    }
  }
  return { status: 'completed', results, channels };
}
