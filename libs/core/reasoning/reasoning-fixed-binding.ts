import type { ReasoningBackend, ReasoningCallOptions } from './reasoning-backend-contracts.js';
import { loadModelRegistry } from './reasoning-model-routing.js';
import {
  loadReasoningRouteUserConfig,
  reasoningRoleInheritsDefault,
  resolveReasoningRoute,
  ReasoningSelectionError,
  type ResolvedReasoningRoute,
} from './reasoning-route-resolver.js';

/** Registry prefixes are metadata; local model tags containing ':' remain intact. */
export function reasoningSelectionWireModel(model?: string): string | undefined {
  if (!model) return undefined;
  return loadModelRegistry().models.some((entry) => entry.model_id === model)
    ? model.slice(model.indexOf(':') + 1)
    : model;
}

const bindings = new WeakMap<ReasoningBackend, ResolvedReasoningRoute>();
export function hasFixedReasoningBinding(backend: ReasoningBackend): boolean {
  return bindings.has(backend);
}
const CALL_OPTIONS: Readonly<Record<string, number>> = {
  divergePersonas: 1,
  crossCritique: 1,
  synthesizePersona: 1,
  forkBranches: 1,
  simulateBranches: 1,
  extractRequirements: 1,
  extractDesignSpec: 1,
  extractTestPlan: 1,
  decomposeIntoTasks: 1,
  delegateTask: 2,
  delegateTaskHandle: 2,
  prompt: 1,
  streamPrompt: 1,
  generateWithTools: 2,
  promptWithImages: 2,
  getRuntimeInstructions: 0,
  getRuntimeProviderName: 0,
};

/** Fail closed if a long-lived process has not installed the currently requested fixed route. */
export function assertFixedReasoningBinding(
  backend: ReasoningBackend,
  role: string,
  options?: ReasoningCallOptions
): void {
  const selection = loadReasoningRouteUserConfig().roles?.[role]?.selection;
  if (selection?.mode !== 'fixed') return;
  const installed = bindings.get(backend);
  if (!installed || installed.selection?.requested.mode !== 'fixed') {
    throw new ReasoningSelectionError(
      'conflict',
      'Fixed settings changed; reselect reasoning backends before execution'
    );
  }
  const route = resolveReasoningRoute({
    role,
    requestedProfile: options?.route_profile,
    requestedModel: options?.model,
  });
  if (
    route.mode !== installed.mode ||
    (route.selection?.modelPinned && route.model !== installed.model) ||
    (options?.route_profile && options.route_profile !== installed.profileRef)
  ) {
    throw new ReasoningSelectionError(
      'conflict',
      'The active backend conflicts with the fixed role target'
    );
  }
  if (route.selection?.modelPinned && options?.model_tier) {
    throw new ReasoningSelectionError(
      'conflict',
      'Model-tier routing conflicts with an exact fixed or broker-pinned model'
    );
  }
}

/** Pin per-call model overrides as well as backend construction and the failover chain. */
export function bindFixedReasoningBackend(
  backend: ReasoningBackend,
  route: ResolvedReasoningRoute
): ReasoningBackend {
  if (route.selection?.requested.mode !== 'fixed') return backend;
  const fixedModel = route.selection.modelPinned
    ? reasoningSelectionWireModel(route.model)
    : undefined;
  const wrapped = new Proxy(backend, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'getNativeSubagentAdopter') {
        return () => {
          throw new ReasoningSelectionError(
            'conflict',
            'Native adoption does not carry fixed reasoning constraints'
          );
        };
      }
      const index = typeof property === 'string' ? CALL_OPTIONS[property] : undefined;
      if (index === undefined) return value.bind(target);
      return (...args: unknown[]) => {
        const options = args[index] as ReasoningCallOptions | undefined;
        assertFixedReasoningBinding(wrapped, route.role, options);
        if (fixedModel) args[index] = { ...options, model: fixedModel };
        return Reflect.apply(value, target, args);
      };
    },
  });
  bindings.set(wrapped, route);
  return wrapped;
}

/** A stale stub or custom backend must reject fixed-role calls until it is reselected. */
export function needsFixedReasoningGuard(backend: ReasoningBackend): boolean {
  return (
    !hasFixedReasoningBinding(backend) &&
    Object.values(loadReasoningRouteUserConfig().roles || {}).some(
      (role) => role.selection?.mode === 'fixed'
    )
  );
}

/** Apply fixed-role constraints before any legacy per-call profile override. */
export function pickRoleBackend(
  defaultBackend: ReasoningBackend,
  roleBackends: ReadonlyMap<string, ReasoningBackend>,
  profileBackends: ReadonlyMap<string, ReasoningBackend>,
  options?: ReasoningCallOptions
): ReasoningBackend {
  const role =
    options?.role
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/g, '_') || 'default';
  const inherited = reasoningRoleInheritsDefault({ role });
  const effectiveRole = inherited ? 'default' : role;
  const roleBackend = inherited ? defaultBackend : roleBackends.get(role) || defaultBackend;
  if (loadReasoningRouteUserConfig().roles?.[effectiveRole]?.selection?.mode === 'fixed') {
    assertFixedReasoningBinding(roleBackend, effectiveRole, options);
    return roleBackend;
  }
  const profile = options?.route_profile?.trim();
  if (profile) return profileBackends.get(profile) || defaultBackend;
  return roleBackend;
}

/** Bound one configured auxiliary request; this does not cap an ongoing agent session. */
export function bindReasoningRequestTimeout(
  backend: ReasoningBackend,
  timeoutMs?: number
): ReasoningBackend {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return backend;
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'prompt' && property !== 'delegateTask') return value.bind(target);
      const index = property === 'prompt' ? 1 : 2;
      return async (...args: unknown[]) => {
        const options = args[index] as ReasoningCallOptions | undefined;
        const controller = new AbortController();
        const callerSignal = options?.signal;
        if (callerSignal?.aborted)
          throw callerSignal.reason || new Error('[DELEGATION_CANCELLED] caller aborted');
        let rejectAbort: (error: unknown) => void = () => {};
        const cancelled = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        const abort = (reason: unknown) => {
          controller.abort(reason);
          rejectAbort(reason);
        };
        const onAbort = () =>
          abort(callerSignal?.reason || new Error('[DELEGATION_CANCELLED] caller aborted'));
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(
          () =>
            abort(
              new Error(
                `[REASONING_REQUEST_TIMEOUT] auxiliary request timed out after ${timeoutMs}ms`
              )
            ),
          timeoutMs
        );
        args[index] = { ...options, signal: controller.signal };
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              if (controller.signal.aborted) throw controller.signal.reason;
              return Reflect.apply(value, target, args);
            }),
            cancelled,
          ]);
          if (controller.signal.aborted) throw controller.signal.reason;
          return result;
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onAbort);
        }
      };
    },
  });
}
