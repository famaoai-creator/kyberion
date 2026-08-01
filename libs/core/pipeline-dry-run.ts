import type { PipelineAdf, PipelineAdfStep } from './pipeline-contract.js';
import { determineActuatorStepType } from './actuator-op-registry.js';
import {
  peekProviderCapabilityRegistry,
  type ProviderCapability,
} from './provider-capability-registry.js';
import { isInstanceDemoted } from './provider-health-registry.js';

export type PipelineDryRunVerdict = 'ready' | 'warning' | 'blocked';

export interface PipelineDryRunCheck {
  id: string;
  status: 'pass' | 'warning' | 'blocked';
  message: string;
  step_id?: string;
}

export interface PipelineDryRunReport {
  version: '1.0';
  pipeline_id: string;
  verdict: PipelineDryRunVerdict;
  side_effects: 'none';
  checks: PipelineDryRunCheck[];
  next_actions: string[];
}

export interface PipelineDryRunOptions {
  providerSnapshot?: ProviderCapability[] | null;
  demotedProviders?: ReadonlySet<string>;
  now?: number;
}

type PipelineWithId = PipelineAdf & { pipeline_id?: string };

const CONTROL_OPS = new Set([
  'if',
  'while',
  'core:if',
  'core:while',
  'core:foreach',
  'core:parallel',
  'core:accumulate',
  'core:include',
  'core:llm_decide',
]);

function collectSteps(steps: PipelineAdfStep[], output: PipelineAdfStep[] = []): PipelineAdfStep[] {
  for (const step of steps) {
    output.push(step);
    const params = step.params || {};
    for (const key of ['then', 'else', 'do', 'calls', 'pipeline', 'steps']) {
      const nested = params[key];
      if (Array.isArray(nested)) collectSteps(nested as PipelineAdfStep[], output);
    }
    if (Array.isArray(step.on_error?.fallback)) collectSteps(step.on_error.fallback, output);
  }
  return output;
}

function addAction(actions: string[], action: string): void {
  if (!actions.includes(action)) actions.push(action);
}

function providerForStep(step: PipelineAdfStep): string | undefined {
  const params = step.params || {};
  for (const key of ['provider', 'provider_id', 'providerId']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/-cli$/u, '');
  }
  return undefined;
}

function requiredProvider(pipeline: PipelineAdf, steps: PipelineAdfStep[]): string | undefined {
  const context = pipeline.context || {};
  const explicit = [
    context.provider,
    context.provider_id,
    (context as Record<string, unknown>).reasoning_provider,
  ].find((value) => typeof value === 'string' && value.trim());
  if (typeof explicit === 'string') return explicit.trim().replace(/-cli$/u, '');

  const stepProvider = steps.map(providerForStep).find(Boolean);
  if (stepProvider) return stepProvider;

  if (steps.some((step) => step.op.startsWith('reasoning:'))) {
    const configured = process.env.KYBERION_REASONING_BACKEND?.trim();
    if (configured) return configured.replace(/-cli$/u, '');
  }
  return undefined;
}

function evaluateProvider(
  provider: string,
  snapshot: ProviderCapability[] | null,
  demotedProviders: ReadonlySet<string>,
  now: number,
  checks: PipelineDryRunCheck[],
  actions: string[]
): void {
  if (demotedProviders.has(provider) || isInstanceDemoted(provider, 'default', now)) {
    checks.push({
      id: 'provider-health',
      status: 'blocked',
      message: `Provider '${provider}' is temporarily demoted.`,
    });
    addAction(
      actions,
      `Wait for provider '${provider}' demotion TTL to expire or choose another provider.`
    );
    return;
  }
  if (!snapshot) {
    checks.push({
      id: 'provider-capability-snapshot',
      status: 'warning',
      message: `No fresh provider capability snapshot is available for '${provider}'.`,
    });
    addAction(
      actions,
      'Run `pnpm baseline` or refresh the provider capability snapshot before execution.'
    );
    return;
  }
  const capability = snapshot.find((entry) => entry.provider_id === provider);
  if (!capability || !capability.binary_found) {
    checks.push({
      id: 'provider-availability',
      status: 'blocked',
      message: `Provider '${provider}' is not available in the capability snapshot.`,
    });
    addAction(
      actions,
      `Install or enable provider '${provider}' and refresh its capability snapshot.`
    );
    return;
  }
  if (capability.authenticated === false) {
    checks.push({
      id: 'provider-auth',
      status: 'blocked',
      message: `Provider '${provider}' is not authenticated.`,
    });
    addAction(actions, `Authenticate provider '${provider}' and refresh its capability snapshot.`);
    return;
  }
  if (capability.authenticated === 'unknown') {
    checks.push({
      id: 'provider-auth',
      status: 'warning',
      message: `Provider '${provider}' is installed, but authentication is unverified.`,
    });
    addAction(actions, `Verify authentication for provider '${provider}' before execution.`);
  } else {
    checks.push({
      id: 'provider-readiness',
      status: 'pass',
      message: `Provider '${provider}' is available and authenticated.`,
    });
  }
}

/**
 * Evaluate a pipeline without dispatching an actuator, probing a provider,
 * opening an MCP connection, or writing a run journal/trace.
 */
export function assessPipelineDryRun(
  pipeline: PipelineWithId,
  options: PipelineDryRunOptions = {}
): PipelineDryRunReport {
  const checks: PipelineDryRunCheck[] = [];
  const actions: string[] = [];
  const steps = collectSteps(pipeline.steps);

  for (const step of steps) {
    if (CONTROL_OPS.has(step.op)) continue;
    const separator = step.op.indexOf(':');
    if (separator < 1) {
      checks.push({
        id: 'capability-resolution',
        status: 'blocked',
        message: `Step '${step.id || step.op}' has no registered domain:action operation.`,
        step_id: step.id || step.op,
      });
      addAction(actions, `Replace '${step.op}' with a registered actuator operation.`);
      continue;
    }
    const domain = step.op.slice(0, separator);
    const action = step.op.slice(separator + 1);
    try {
      determineActuatorStepType(domain, action);
      checks.push({
        id: 'capability-resolution',
        status: 'pass',
        message: `Operation '${step.op}' is registered.`,
        step_id: step.id || step.op,
      });
    } catch (error) {
      checks.push({
        id: 'capability-resolution',
        status: 'blocked',
        message: error instanceof Error ? error.message : String(error),
        step_id: step.id || step.op,
      });
      addAction(actions, `Register or replace actuator operation '${step.op}'.`);
    }
  }

  const required = requiredProvider(pipeline, steps);
  if (required) {
    evaluateProvider(
      required,
      options.providerSnapshot === undefined
        ? peekProviderCapabilityRegistry()
        : options.providerSnapshot,
      options.demotedProviders || new Set<string>(),
      options.now ?? Date.now(),
      checks,
      actions
    );
  } else if (steps.some((step) => step.op.startsWith('reasoning:'))) {
    checks.push({
      id: 'provider-selection',
      status: 'warning',
      message: 'Reasoning steps are present but no provider is explicitly selected.',
    });
    addAction(
      actions,
      'Select a reasoning provider or configure KYBERION_REASONING_BACKEND before execution.'
    );
  }

  const flowErrors = validateStaticFlow(steps, pipeline.context || {});
  for (const error of flowErrors) {
    checks.push({ id: 'flow-contract', status: 'blocked', message: error });
    addAction(actions, `Provide upstream channel(s): ${error}.`);
  }
  if (flowErrors.length === 0) {
    checks.push({
      id: 'flow-contract',
      status: 'pass',
      message: 'All consumed channels have a static producer or initial context value.',
    });
  }

  const hasBlocked = checks.some((check) => check.status === 'blocked');
  const hasWarning = checks.some((check) => check.status === 'warning');
  return {
    version: '1.0',
    pipeline_id: pipeline.pipeline_id || pipeline.name || 'unnamed-pipeline',
    verdict: hasBlocked ? 'blocked' : hasWarning ? 'warning' : 'ready',
    side_effects: 'none',
    checks,
    next_actions: actions,
  };
}

function validateStaticFlow(
  steps: PipelineAdfStep[],
  initialContext: Record<string, unknown>
): string[] {
  const available = new Set(Object.keys(initialContext));
  const errors: string[] = [];
  for (const step of steps) {
    const consumed = step.consumes
      ? Array.isArray(step.consumes)
        ? step.consumes
        : [step.consumes]
      : [];
    const missing = consumed.filter((channel) => !available.has(channel));
    if (missing.length) errors.push(`${step.id || step.op}: ${missing.join(', ')}`);
    const produced = step.produces
      ? typeof step.produces === 'string'
        ? step.produces
        : step.produces.channel
      : typeof step.params.export_as === 'string'
        ? step.params.export_as
        : undefined;
    if (produced) available.add(produced);
  }
  return errors;
}
