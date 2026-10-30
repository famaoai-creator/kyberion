import {
  assertCredentialOwner,
  credentialBindingReadiness,
} from '../foundation/credential-binding.js';
import { buildFailoverReasoningBackend } from './reasoning-backend.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeResolution } from '../scope-context.js';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import type { InstallReasoningOptions } from './reasoning-bootstrap.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningProviderRuntimeBundle } from './reasoning-provider-registry.js';
import {
  bindFixedReasoningBackend,
  bindReasoningRequestTimeout,
  reasoningSelectionWireModel,
} from './reasoning-fixed-binding.js';
import {
  ReasoningSelectionError,
  resolveReasoningRouteCandidates,
} from './reasoning-route-resolver.js';

/** Construction ports reuse the host's governed provider adapters without installing global seams. */
export interface TaskReasoningConstruction {
  buildBundle(
    mode: ReasoningBackendMode,
    options: InstallReasoningOptions
  ): ReasoningProviderRuntimeBundle | null;
  filterChain(chain: ReasoningProviderRuntimeBundle[]): ReasoningProviderRuntimeBundle[];
}

/** Construct only after the claimed task has entered its trusted credential binding. */
export function constructTaskReasoningBackend(
  options: InstallReasoningOptions,
  construction: TaskReasoningConstruction
): ReasoningBackend {
  const readiness = credentialBindingReadiness();
  if (readiness.status === 'binding_required') {
    throw new Error(
      '[CREDENTIAL_BINDING_REQUIRED] Construct the task backend after claimed WorkItem credential dispatch.'
    );
  }
  const scope =
    currentScopeEnvelope()?.identity ??
    resolveScopeResolution(
      {
        tenant_slug: readiness.identity.tenantSlug,
        mission_id: readiness.identity.missionId,
        task_id: readiness.identity.taskId,
      },
      process.env,
      { inferFromMission: false, inferFromCwd: false }
    ).scope;
  if (
    scope.tenant_slug !== readiness.identity.tenantSlug ||
    scope.mission_id !== readiness.identity.missionId ||
    scope.task_id !== readiness.identity.taskId
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Task routing scope contradicts credential identity');
  }
  const routes = resolveReasoningRouteCandidates({
    scope,
    role: options.role || 'default',
    requestedProfile: options.profile,
    requestedMode: options.mode,
    requestedModel: options.model,
    sampling: options.samplingParams,
  });
  const primary = routes[0];
  if (!primary)
    throw new ReasoningSelectionError('unavailable', 'No task reasoning route is available');
  const fixed = primary.selection?.requested.mode === 'fixed';
  const candidates: ReasoningProviderRuntimeBundle[] = [];
  for (const route of routes) {
    if (route.mode === 'stub') continue;
    const bundle = construction.buildBundle(route.mode as ReasoningBackendMode, {
      ...options,
      model: reasoningSelectionWireModel(route.model),
      samplingParams: route.parameters,
      toolsEnabled: route.toolsEnabled,
      allowedTools: route.allowedTools,
      contextWindowTokens: route.limits.contextWindowTokens ?? options.contextWindowTokens,
      maxCompletionTokens: route.limits.maxCompletionTokens ?? options.maxCompletionTokens,
      timeoutMs: route.limits.timeoutMs ?? options.timeoutMs,
    });
    if (bundle) candidates.push(bundle);
    else if (fixed)
      throw new ReasoningSelectionError(
        'unavailable',
        'Fixed task backend could not be constructed'
      );
  }
  const chain = construction.filterChain(candidates);
  if (!chain.length || (fixed && chain.length !== 1)) {
    throw new ReasoningSelectionError(
      'unavailable',
      'No usable task reasoning backend; implicit stub execution is disabled'
    );
  }
  const backend = bindReasoningRequestTimeout(
    buildFailoverReasoningBackend(
      chain.map((candidate) => candidate.backend),
      primary.failover
    ),
    primary.limits.timeoutMs
  );
  // Retained task-local handles must not become a cross-task credential cache.
  const owned = new Proxy(backend, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertCredentialOwner(readiness.identity);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return bindFixedReasoningBackend(owned, primary, { nativeAdoption: 'disabled' });
}
