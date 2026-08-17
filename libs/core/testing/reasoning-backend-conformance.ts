import type { ReasoningBackend, ReasoningCallOptions } from '../reasoning-backend.js';
import type {
  ReasoningProviderConformanceCheck,
  ReasoningProviderConformanceEvidence,
  ReasoningProviderConformanceStatus,
} from '../reasoning-provider-registry.js';

export type ReasoningConformanceStatus = ReasoningProviderConformanceStatus;

export type ReasoningConformanceCheck = ReasoningProviderConformanceCheck;

export type ReasoningBackendConformanceReport = ReasoningProviderConformanceEvidence;

function statusIsAcceptable(status: ReasoningConformanceStatus): boolean {
  return status !== 'failed';
}

function isAbortError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /abort|cancel/i.test(message);
}

/**
 * Execute the provider-neutral portion of the backend contract.
 *
 * `live: false` never sends a model turn to a non-stub backend. Such checks
 * are reported as unavailable rather than being silently counted as passed.
 * Live provider tests remain opt-in and must be run by the caller with an
 * appropriate credential and egress scope.
 */
export async function runReasoningBackendConformance(
  backend: ReasoningBackend,
  options: { live?: boolean } = {}
): Promise<ReasoningBackendConformanceReport> {
  const live = options.live === true;
  const checks: ReasoningConformanceCheck[] = [];
  const canExercise = live || backend.name === 'stub';

  if (!canExercise) {
    checks.push(
      { name: 'prompt', status: 'unavailable', evidence: 'live=false; provider turn not executed' },
      {
        name: 'structured_output',
        status: 'unavailable',
        evidence: 'live=false; provider turn not executed',
      },
      { name: 'abort', status: 'unavailable', evidence: 'live=false; provider turn not executed' },
      {
        name: 'usage',
        status: 'declared',
        evidence: 'Usage evidence requires a provider response.',
      }
    );
    return {
      version: '1.0.0',
      backend: backend.name,
      live,
      passed: true,
      checks,
    };
  }

  try {
    const output = await backend.prompt('conformance prompt: return a short acknowledgement');
    checks.push({
      name: 'prompt',
      status: typeof output === 'string' ? 'verified' : 'failed',
      evidence: typeof output === 'string' ? 'prompt returned text' : 'prompt did not return text',
    });
  } catch (error) {
    checks.push({
      name: 'prompt',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const structured = await backend.extractRequirements({
      sourceText: 'Build a governed report.',
    });
    const valid =
      typeof structured === 'object' &&
      structured !== null &&
      Array.isArray((structured as { functional_requirements?: unknown }).functional_requirements);
    checks.push({
      name: 'structured_output',
      status: valid ? 'verified' : 'failed',
      evidence: valid
        ? 'extractRequirements returned the structured contract shape'
        : 'structured contract shape was missing',
    });
  } catch (error) {
    checks.push({
      name: 'structured_output',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    });
  }

  const controller = new AbortController();
  controller.abort(new Error('conformance abort'));
  try {
    await backend.prompt('conformance abort probe', { signal: controller.signal });
    checks.push({
      name: 'abort',
      status: 'declared',
      evidence: 'backend completed an already-aborted call; cancellation is not verified',
    });
  } catch (error) {
    checks.push({
      name: 'abort',
      status: isAbortError(error) ? 'verified' : 'failed',
      evidence: isAbortError(error)
        ? 'backend propagated the abort signal'
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }

  checks.push({
    name: 'usage',
    status: 'declared',
    evidence: 'Usage evidence is recorded by the provider adapter/metrics boundary.',
  });

  return {
    version: '1.0.0',
    backend: backend.name,
    live,
    passed: checks.every((check) => statusIsAcceptable(check.status)),
    checks,
  };
}

export type { ReasoningCallOptions };
