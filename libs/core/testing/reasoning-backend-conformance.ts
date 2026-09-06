import {
  FailoverReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
  type ReasoningCallOptions,
} from '../reasoning-backend.js';
import {
  assertReasoningEgressAllowedAtEndpoint,
  withReasoningPayloadScope,
  type ReasoningPayloadScope,
} from '../reasoning-egress-scope.js';
import type {
  ReasoningProviderConformanceCheck,
  ReasoningProviderConformanceEvidence,
  ReasoningProviderConformanceStatus,
} from '../reasoning-provider-registry.js';

export type ReasoningConformanceStatus = ReasoningProviderConformanceStatus;

export type ReasoningConformanceCheck = ReasoningProviderConformanceCheck;

export type ReasoningBackendConformanceReport = ReasoningProviderConformanceEvidence;

export interface ReasoningConformanceFailoverObservation {
  primary_failed: boolean;
  fallback_served: boolean;
  primary_failure_propagated: boolean;
}

export interface ReasoningConformanceEgressObservation {
  external_denied: boolean;
  local_allowed: boolean;
}

export interface ReasoningConformanceUsageObservation {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  source: 'provider' | 'estimated';
}

/**
 * Runtime evidence for a provider sandbox. A help flag is deliberately not
 * accepted here: the probe must attempt a write in a disposable location and
 * observe both that the write was blocked and that the sentinel did not exist.
 * `not_applicable` is explicit for API providers without a local process
 * sandbox and must not be inferred from a missing probe.
 */
export interface ReasoningConformanceSandboxObservation {
  write_attempt_blocked?: boolean;
  sentinel_created?: boolean;
  not_applicable?: boolean;
  evidence: string;
}

export interface ReasoningBackendConformanceProbes {
  /** Provider/runtime observation of a real primary failure reaching fallback. */
  failover?: () =>
    | ReasoningConformanceFailoverObservation
    | undefined
    | Promise<ReasoningConformanceFailoverObservation | undefined>;
  /** Provider/runtime observation of the adapter's egress enforcement. */
  egress_scope?: () =>
    | ReasoningConformanceEgressObservation
    | undefined
    | Promise<ReasoningConformanceEgressObservation | undefined>;
  /** Provider usage receipt captured at the adapter boundary after the probe turn. */
  usage?: () =>
    | ReasoningConformanceUsageObservation
    | undefined
    | Promise<ReasoningConformanceUsageObservation | undefined>;
  /** Runtime provider probe; help/version output is not sufficient evidence. */
  sandbox_enforcement?: () =>
    | ReasoningConformanceSandboxObservation
    | undefined
    | Promise<ReasoningConformanceSandboxObservation | undefined>;
}

export interface ReasoningBackendConformanceOptions {
  live?: boolean;
  probes?: ReasoningBackendConformanceProbes;
}

function statusIsAcceptable(status: ReasoningConformanceStatus): boolean {
  return status !== 'failed';
}

function isAbortError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /abort|cancel/i.test(message);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validUsageObservation(
  value: ReasoningConformanceUsageObservation | undefined
): value is ReasoningConformanceUsageObservation {
  return (
    value !== undefined &&
    isNonNegativeFiniteNumber(value.input_tokens) &&
    isNonNegativeFiniteNumber(value.output_tokens) &&
    isNonNegativeFiniteNumber(value.total_tokens) &&
    value.total_tokens === value.input_tokens + value.output_tokens &&
    (value.source === 'provider' || value.source === 'estimated')
  );
}

function validSandboxObservation(
  value: ReasoningConformanceSandboxObservation | undefined
): boolean {
  if (!value || typeof value.evidence !== 'string' || !value.evidence.trim()) return false;
  if (value.not_applicable === true) {
    return value.write_attempt_blocked === undefined && value.sentinel_created === undefined;
  }
  return value.write_attempt_blocked === true && value.sentinel_created === false;
}

async function runFailoverProbe(
  backend: ReasoningBackend,
  probe: ReasoningBackendConformanceProbes['failover']
): Promise<ReasoningConformanceFailoverObservation | undefined> {
  if (probe) return probe();
  let primaryFailed = false;
  let fallbackInvoked = false;
  let fallbackServed = false;
  const primary: ReasoningBackend = {
    ...stubReasoningBackend,
    name: 'conformance-primary',
    async prompt() {
      primaryFailed = true;
      throw new Error('503 conformance primary unavailable');
    },
  };
  const fallback = new FailoverReasoningBackend(
    [
      { backend: primary, label: 'conformance-primary' },
      {
        backend: {
          ...backend,
          async prompt(prompt, options) {
            fallbackInvoked = true;
            const output = await backend.prompt(prompt, options);
            fallbackServed = true;
            return output;
          },
        },
        label: 'conformance-fallback',
      },
    ],
    { max_in_place_retries: 0 }
  );
  try {
    await withReasoningPayloadScope(
      {
        tier: 'public',
        purpose: 'provider-neutral conformance failover probe',
      },
      () => fallback.prompt('conformance failover probe')
    );
  } catch {
    // The observation below reports the failed contract rather than masking it.
  }
  return {
    primary_failed: primaryFailed,
    fallback_served: fallbackServed,
    primary_failure_propagated: primaryFailed && fallbackInvoked,
  };
}

async function runEgressProbe(
  backend: ReasoningBackend,
  probe: ReasoningBackendConformanceProbes['egress_scope']
): Promise<ReasoningConformanceEgressObservation | undefined> {
  if (probe) return probe();
  const scope: ReasoningPayloadScope = {
    tier: 'confidential',
    tenant_slug: 'conformance-tenant',
    purpose: 'backend conformance egress probe',
  };
  let externalDenied = false;
  let localAllowed = false;
  try {
    withReasoningPayloadScope(scope, () =>
      assertReasoningEgressAllowedAtEndpoint(backend.name, 'https://unapproved.conformance.invalid')
    );
  } catch (error) {
    externalDenied = /REASONING_EGRESS_DENIED/u.test(
      error instanceof Error ? error.message : String(error)
    );
  }
  try {
    withReasoningPayloadScope(scope, () =>
      assertReasoningEgressAllowedAtEndpoint(backend.name, 'http://127.0.0.1:9')
    );
    localAllowed = true;
  } catch {
    localAllowed = false;
  }
  return { external_denied: externalDenied, local_allowed: localAllowed };
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
  options: ReasoningBackendConformanceOptions = {}
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
        name: 'failover',
        status: 'unavailable',
        evidence: 'live=false; provider failover not exercised',
      },
      {
        name: 'egress_scope',
        status: 'unavailable',
        evidence: 'live=false; provider egress not exercised',
      },
      {
        name: 'usage',
        status: 'declared',
        evidence: 'Usage evidence requires a provider response.',
      },
      {
        name: 'sandbox_enforcement',
        status: 'declared',
        evidence: 'Stub has no provider process boundary; runtime sandbox probe is not applicable.',
      }
    );
    return {
      version: '1.0.0',
      backend: backend.name,
      live,
      // An unavailable check is not a conformance pass. Keep the report
      // useful for offline diagnostics, but fail closed so callers cannot
      // mistake an unexecuted provider turn for verified evidence.
      passed: false,
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
      status: 'failed',
      evidence: 'backend completed an already-aborted call; cancellation was ignored',
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
    name: 'failover',
    status: 'unavailable',
    evidence: 'Failover evidence requires an executable provider/runtime probe.',
  });

  try {
    const observation = await runFailoverProbe(backend, options.probes?.failover);
    const valid =
      observation?.primary_failed === true &&
      observation.fallback_served === true &&
      observation.primary_failure_propagated === true;
    checks[checks.length - 1] = {
      name: 'failover',
      status: valid ? 'verified' : 'failed',
      evidence: valid
        ? 'Primary failure reached and was served by the fallback backend.'
        : 'Primary failure did not reach a successful fallback observation.',
    };
  } catch (error) {
    checks[checks.length - 1] = {
      name: 'failover',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }

  checks.push({
    name: 'egress_scope',
    status: 'unavailable',
    evidence: 'Egress evidence requires an executable provider/runtime probe.',
  });
  try {
    const observation = await runEgressProbe(backend, options.probes?.egress_scope);
    const valid = observation?.external_denied === true && observation.local_allowed === true;
    checks[checks.length - 1] = {
      name: 'egress_scope',
      status: valid ? 'verified' : 'failed',
      evidence: valid
        ? 'Confidential external egress was denied and local egress remained available.'
        : 'Egress scope did not produce both deny and local-allow evidence.',
    };
  } catch (error) {
    checks[checks.length - 1] = {
      name: 'egress_scope',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }

  checks.push({
    name: 'usage',
    status: 'unavailable',
    evidence: 'Usage evidence requires a provider adapter receipt.',
  });

  try {
    const observation = await options.probes?.usage?.();
    if (validUsageObservation(observation)) {
      checks[checks.length - 1] = {
        name: 'usage',
        status: observation.source === 'provider' ? 'verified' : 'declared',
        evidence: `${observation.source} usage receipt reported ${observation.total_tokens} total tokens.`,
      };
    }
  } catch (error) {
    checks[checks.length - 1] = {
      name: 'usage',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }

  checks.push({
    name: 'sandbox_enforcement',
    status: backend.name === 'stub' ? 'declared' : 'unavailable',
    evidence:
      backend.name === 'stub'
        ? 'Stub has no provider process boundary; runtime sandbox probe is not applicable.'
        : 'Runtime sandbox evidence requires an explicit provider probe; help flags are insufficient.',
  });
  try {
    const observation = await options.probes?.sandbox_enforcement?.();
    if (observation) {
      checks[checks.length - 1] = {
        name: 'sandbox_enforcement',
        status: validSandboxObservation(observation) ? 'verified' : 'failed',
        evidence: observation.evidence,
      };
    }
  } catch (error) {
    checks[checks.length - 1] = {
      name: 'sandbox_enforcement',
      status: 'failed',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    version: '1.0.0',
    backend: backend.name,
    live,
    passed:
      checks.every((check) => statusIsAcceptable(check.status)) &&
      checks.every((check) => !live || check.status !== 'unavailable'),
    checks,
  };
}

export type { ReasoningCallOptions };
