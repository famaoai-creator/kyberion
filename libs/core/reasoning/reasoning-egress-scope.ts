import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../logger.js';
import { evaluateEgressPolicy } from '../egress-policy.js';
import { isLocalOnlyReasoningBackend } from '../backend-capability-profile.js';
import { assertSandboxNetworkAllowed } from '../shell/sandbox-policy.js';
import {
  isLocalReasoningEndpoint,
  resolveReasoningProviderDescriptor,
} from './reasoning-provider-registry.js';
import {
  evaluateProviderEgress,
  lookupTenantProviderAttestation,
  providerIdForReasoningIdentifier,
} from '../provider/provider-egress-gate.js';

/**
 * Tier context for reasoning-backend sends.
 *
 * `secureFetch` carries the tier-aware egress gate (SA-04 Task 2), but
 * reasoning backends talk to their providers through each SDK's own HTTP
 * client and never pass through it. That leaves the single highest-risk
 * outbound path — whole documents and rendered pages going to a model —
 * outside the control that exists precisely for it.
 *
 * This module closes that path. A caller that knows it is holding tenant
 * material wraps the work in `withReasoningPayloadScope`, and every send made
 * inside that scope is checked against the same policy.
 *
 * Async-local rather than env-var based on purpose: reasoning calls run
 * concurrently behind a semaphore, and an env var set around one call would be
 * visible to every other call in flight.
 */

const logger = createLogger('reasoning-egress');

export type ReasoningTrainingUse = 'local_only' | 'zero_retention' | 'training_eligible';

export interface ReasoningPayloadScope {
  /** Most sensitive tier represented in what will be sent. */
  tier: 'public' | 'confidential' | 'personal';
  /** Tenant the material belongs to, when above public. */
  tenant_slug?: string;
  /** What is being sent, recorded on denial. */
  purpose?: string;
  /** Maximum provider data-use posture. Defaults to local_only. */
  training_use?: ReasoningTrainingUse;
}

const scopeStorage = new AsyncLocalStorage<ReasoningPayloadScope>();

/** Run `fn` with every reasoning send inside it governed by this scope. */
export function withReasoningPayloadScope<T>(scope: ReasoningPayloadScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function getReasoningPayloadScope(): ReasoningPayloadScope | undefined {
  return scopeStorage.getStore();
}

export function isLocalReasoningBackend(backendName: string): boolean {
  return isLocalOnlyReasoningBackend(backendName);
}

function reasoningDataPolicy(backendName: string): ReasoningTrainingUse {
  return isLocalReasoningBackend(backendName) ? 'local_only' : 'training_eligible';
}

/**
 * Where a named backend sends data.
 *
 * RS-01: the destination is the provider descriptor's `endpoint`
 * (`reasoning-providers/*.json`), resolved from a mode, a runtime backend
 * alias, or a provider id. An unrecognized backend — or one without a static
 * endpoint (configurable adapters use the endpoint-aware check below) —
 * resolves to an invalid placeholder host, which the tenant rule denies: the
 * safe direction when an unknown provider would be handed tenant material.
 */
export function reasoningBackendEndpoint(backendName: string): string {
  return (
    resolveReasoningProviderDescriptor(backendName)?.endpoint ??
    `https://${backendName}.unknown-provider.invalid`
  );
}

export class ReasoningEgressDeniedError extends Error {
  constructor(reason: string) {
    super(`[REASONING_EGRESS_DENIED] ${reason}`);
    this.name = 'ReasoningEgressDeniedError';
  }
}

let tenantRegistryRootForTests: string | undefined;

/** Test-only: point the attestation lookup at a hermetic tenant registry root. */
export function _setReasoningTenantRegistryRootForTests(rootDir: string | undefined): void {
  tenantRegistryRootForTests = rootDir;
}

/**
 * `zero_retention` toward an external backend is allowed only when the
 * tenant that owns the material holds a valid (unexpired) provider attestation
 * of `training_use: 'none'` for the backend's egress provider id — the same
 * attestation `checkProviderEgress` honours, read through the same governed
 * lookup. For confidential/personal material the send must additionally pass
 * `evaluateProviderEgress` — the side-effect-free evaluator behind
 * `checkProviderEgress` — so the tenant's `allowed_reasoning_backends` and the
 * provider-declared / approved_providers rule apply exactly as they do on the
 * delegation face. Anything else keeps the fail-closed denial.
 */
function assertZeroRetentionAttested(backendName: string, scope: ReasoningPayloadScope): void {
  const next =
    "next: record one with 'pnpm onboarding llm attest --request-approval' (or 'pnpm tenant attest-provider'), or declare training_use 'training_eligible' explicitly";
  const deny = (why: string, evidence: string): never => {
    throw new ReasoningEgressDeniedError(
      `backend ${backendName} has no zero_retention declaration — ${why} | ${next} | ${evidence}`
    );
  };
  const provider = providerIdForReasoningIdentifier(backendName);
  if (!provider) {
    deny(
      'the backend maps to no egress provider id, so no tenant attestation can cover it',
      `backend=${backendName}`
    );
  }
  const tenantSlug = scope.tenant_slug?.trim();
  if (!tenantSlug) {
    deny(
      'the payload scope names no tenant_slug whose provider attestation could apply',
      `provider=${provider}`
    );
  }
  const attestation = lookupTenantProviderAttestation({
    tenant_slug: tenantSlug,
    provider,
    ...(tenantRegistryRootForTests ? { tenant_registry_root_dir: tenantRegistryRootForTests } : {}),
  });
  const evidence = `tenant=${tenantSlug} provider=${provider} attestation=${attestation.status}`;
  if (attestation.error) {
    deny(`the tenant attestation lookup failed: ${attestation.error}`, evidence);
  }
  if (attestation.status === 'absent') {
    deny(`tenant '${tenantSlug}' has no attestation for provider '${provider}'`, evidence);
  }
  if (attestation.status === 'expired') {
    deny(
      `tenant '${tenantSlug}' attestation for provider '${provider}' expired${attestation.expires_at ? ` on ${attestation.expires_at}` : ''}`,
      evidence
    );
  }
  if (attestation.training_use !== 'none') {
    deny(
      `tenant '${tenantSlug}' attests training_use '${attestation.training_use}' for provider '${provider}'`,
      `${evidence} training_use=${attestation.training_use}`
    );
  }
  if (scope.tier === 'public') return;
  const decision = evaluateProviderEgress({
    provider,
    dataTier: scope.tier,
    tenant_slug: tenantSlug,
    ...(tenantRegistryRootForTests ? { tenant_registry_root_dir: tenantRegistryRootForTests } : {}),
  });
  if (!decision.allowed) {
    deny(
      `the provider egress policy denies ${scope.tier} material: ${decision.reason ?? 'denied'}`,
      `${evidence} tier=${scope.tier}`
    );
  }
}

/**
 * Throw if the ambient scope forbids sending to this backend.
 *
 * Without an ambient scope, local endpoints and explicitly allowlisted public
 * endpoints remain usable. Unknown public destinations are denied until the
 * caller declares a payload scope, so a missing scope cannot silently turn
 * into unrestricted external egress.
 */
export function assertReasoningEgressAllowed(backendName: string): void {
  assertSandboxNetworkAllowed(reasoningBackendEndpoint(backendName));
  // This overload has no endpoint information. The endpoint-aware path below
  // is the enforcement point for configurable adapters; preserve the
  // name-only local declaration for callers that only have a backend id.
  if (isLocalReasoningBackend(backendName)) return;
  assertReasoningEgressAllowedAtEndpoint(backendName, reasoningBackendEndpoint(backendName));
}

/** Apply the same gate when an adapter has a configurable provider endpoint. */
export function assertReasoningEgressAllowedAtEndpoint(
  backendName: string,
  endpoint: string
): void {
  assertSandboxNetworkAllowed(endpoint);
  const localEndpoint = isLocalReasoningEndpoint(endpoint);
  if (isLocalReasoningBackend(backendName) && !localEndpoint) {
    throw new ReasoningEgressDeniedError(
      `[REASONING_EGRESS_DENIED] Local-only backend ${backendName} must use a local endpoint: ${endpoint}`
    );
  }
  const scope = getReasoningPayloadScope();
  if (!scope) {
    // A missing scope is treated as public only after the destination itself
    // is approved. This preserves ordinary public prompts while preventing a
    // forgotten scope declaration from becoming an unrestricted exfiltration
    // path to arbitrary endpoints.
    if (localEndpoint) return;
    const decision = evaluateEgressPolicy(endpoint, { tier: 'public' });
    if (decision.verdict !== 'allow') {
      throw new ReasoningEgressDeniedError(
        `[REASONING_EGRESS_SCOPE_REQUIRED] ${backendName} endpoint is not approved without an explicit payload scope: ${decision.reason}`
      );
    }
    return;
  }
  // A local endpoint is safe even when the adapter uses a provider-neutral
  // runtime name such as `openai-compatible`.
  if (localEndpoint) return;
  if ((scope.training_use ?? 'local_only') === 'local_only') {
    throw new ReasoningEgressDeniedError(
      `training_use 'local_only' forbids sending ${scope.tier} material to external backend ${backendName}`
    );
  }
  if (
    scope.training_use === 'zero_retention' &&
    reasoningDataPolicy(backendName) === 'training_eligible'
  ) {
    assertZeroRetentionAttested(backendName, scope);
  }
  if (scope.tier === 'public') return;

  const decision = evaluateEgressPolicy(endpoint, {
    tier: scope.tier,
    tenant_slug: scope.tenant_slug,
    purpose: scope.purpose ?? 'reasoning backend call',
  });
  if (decision.verdict === 'deny') {
    logger.warn(
      `[EGRESS] blocked a ${scope.tier} payload from reaching ${backendName}: ${decision.reason}`
    );
    throw new ReasoningEgressDeniedError(decision.reason);
  }
}
