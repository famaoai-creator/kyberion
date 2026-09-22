/**
 * authz-policy-engine seam — authorization as a selectable provider.
 *
 * Companion to `authn-principal-resolver.ts`: that seam answers "who is
 * this" (a verified {@link ResolvedPrincipal}); this seam answers "may they"
 * against an operation + resource. Provider selection runs through the same
 * shared machinery (seam-provider-selection.ts) so operator rules, mission
 * pins and audit apply identically.
 *
 * Unlike authn, there is no fall-through: the selected provider's decision
 * IS the verdict. A provider that cannot evaluate a query declares itself
 * ineligible up front (`canAuthorize`), and an evaluation error becomes a
 * deny — never an exception through the seam boundary (fail closed).
 *
 * Built-in providers (authz-providers.ts, self-registering on import):
 *   role-scope         — the current role + scope-containment model
 *                        (surface-authorization.ts)
 *   member-membership  — member-registry memberships → front-desk roles
 *   policy-file        — declarative governed JSON rules (deny wins)
 *   allow-all / deny-all — test & lockdown providers
 */

import { auditChain } from './audit-chain.js';
import { isVitestProcess } from './foundation/env.js';
import { createLogger } from './logger.js';
import type { ActorKind } from './actor.js';
import type { MemberRegistryPathOptions } from './member-registry.js';
import type {
  SurfaceAuthorizationReasonCode,
  SurfaceAuthorizationRole,
  SurfacePermission,
} from './surface-authorization.js';
import {
  resolveSeamProviderDecision,
  type SeamProviderCandidate,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import type { ResolvedPrincipal } from './authn-principal-resolver.js';

const logger = createLogger('authz-policy-engine');

export const AUTHZ_SEAM_ID = 'authz-policy-engine';

// ---------------------------------------------------------------------------
// Query / decision model
// ---------------------------------------------------------------------------

/** `decide` is the approver-only slice (surface.decision.write). */
export type AuthzEffect = 'read' | 'write' | 'decide';

export interface AuthzOperation {
  operationId: string;
  effect: AuthzEffect;
  /** Defaults to the canonical permission for the effect. */
  requiredPermissions?: readonly SurfacePermission[];
  requiredRole?: SurfaceAuthorizationRole;
}

export interface AuthzResource {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  tier?: string;
}

export interface AuthzQuery {
  principal: ResolvedPrincipal;
  operation: AuthzOperation;
  resource?: AuthzResource;
}

export type AuthzReasonCode =
  | SurfaceAuthorizationReasonCode
  | 'member_not_found'
  | 'member_inactive'
  | 'policy_rule_denied'
  | 'no_matching_rule'
  | 'provider_error'
  | 'unresolved';

export interface AuthzDecision {
  allowed: boolean;
  operationId: string;
  reasonCode: AuthzReasonCode;
  reason: string;
  policyId: string;
  /** The provider id that produced the verdict. */
  provider: string;
}

export class AuthzError extends Error {
  constructor(
    public readonly decision: AuthzDecision,
    message = decision.reason
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

// ---------------------------------------------------------------------------
// Provider contract + registry
// ---------------------------------------------------------------------------

export interface AuthzProviderCapabilities {
  /** Actor kinds this engine can judge (subset of 'human'|'agent'|'service'). */
  principalKinds: ActorKind[];
  effects: AuthzEffect[];
  tenantAware: boolean;
  memberAware: boolean;
  /** Needs an external policy/config to be meaningful. */
  requiresConfig: boolean;
}

export interface AuthzResolveDeps {
  env?: Record<string, string | undefined>;
  memberRegistry?: MemberRegistryPathOptions;
  /** policy-file: explicit rules file override (tests). */
  policyPath?: string;
}

export interface AuthzEligibility {
  eligible: boolean;
  unmet?: string[];
}

export interface AuthzProvider {
  id: string;
  capabilities: AuthzProviderCapabilities;
  canAuthorize(query: AuthzQuery, deps?: AuthzResolveDeps): AuthzEligibility;
  /** Evaluate the query. Must return a decision; throws are treated as bugs. */
  authorize(query: AuthzQuery, deps?: AuthzResolveDeps): AuthzDecision;
}

const providerRegistry = new Map<string, AuthzProvider>();

export function registerAuthzProvider(provider: AuthzProvider): void {
  providerRegistry.set(provider.id, provider);
}

export function getAuthzProvider(id: string): AuthzProvider | null {
  return providerRegistry.get(id) ?? null;
}

export function listAuthzProviders(restrictTo?: readonly string[]): AuthzProvider[] {
  const all = [...providerRegistry.values()];
  return restrictTo?.length ? all.filter((p) => restrictTo.includes(p.id)) : all;
}

// ---------------------------------------------------------------------------
// Audit — injectable sink, vitest-safe (same discipline as the authn seam)
// ---------------------------------------------------------------------------

export interface AuthzAuditEvent {
  action: 'authz_decision';
  provider: string | null;
  operation: string;
  actor_id?: string;
  allowed: boolean;
  reason_code?: AuthzReasonCode;
}

type AuthzAuditSink = (event: AuthzAuditEvent) => void;
let auditSinkOverride: AuthzAuditSink | null = null;

/** Test hook: observe authz outcomes without the real audit tree. */
export function setAuthzAuditSinkForTests(sink: AuthzAuditSink | null): void {
  auditSinkOverride = sink;
}

function recordAuthz(event: AuthzAuditEvent): void {
  try {
    if (auditSinkOverride) {
      auditSinkOverride(event);
      return;
    }
    if (isVitestProcess()) return;
    auditChain.record({
      agentId: event.actor_id ?? 'authz-policy-engine',
      action: 'authz_decision',
      operation: `${AUTHZ_SEAM_ID}/${event.operation}`,
      result: event.allowed ? 'completed' : 'denied',
      reason: event.reason_code,
      metadata: { provider: event.provider, allowed: event.allowed },
    });
  } catch (error) {
    logger.warn(
      `[authz] audit append failed (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Selection + evaluation
// ---------------------------------------------------------------------------

export interface AuthorizeWithPolicyEngineOptions {
  purpose?: string;
  context?: Record<string, string>;
  decisionKey?: string;
  pin?: boolean;
  record?: boolean;
  providerIds?: readonly string[];
  deps?: AuthzResolveDeps;
}

export interface AuthzResolution {
  authorization: AuthzDecision;
  decision: SeamProviderDecision;
}

function deniedDecision(
  query: AuthzQuery,
  provider: string,
  reasonCode: AuthzReasonCode,
  reason: string
): AuthzDecision {
  return {
    allowed: false,
    operationId: query.operation.operationId,
    reasonCode,
    reason,
    policyId: `${provider}:${query.operation.operationId}`,
    provider,
  };
}

/**
 * Evaluate an authorization query through the seam: hard-filter → policy
 * decision → the selected provider's verdict. No provider → deny. Provider
 * throws → deny ('provider_error'). Fail closed everywhere.
 */
export function authorizeWithPolicyEngine(
  query: AuthzQuery,
  options: AuthorizeWithPolicyEngineOptions = {}
): AuthzResolution {
  const providers = listAuthzProviders(options.providerIds);
  const candidates: SeamProviderCandidate[] = providers.map((provider) => {
    let eligibility: AuthzEligibility;
    try {
      eligibility = provider.canAuthorize(query, options.deps);
    } catch (error) {
      eligibility = {
        eligible: false,
        unmet: [
          `eligibility check failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    return { id: provider.id, eligible: eligibility.eligible, unmet: eligibility.unmet };
  });
  const decision = resolveSeamProviderDecision({
    seam: AUTHZ_SEAM_ID,
    candidates,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.decisionKey ? { decisionKey: options.decisionKey } : {}),
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
    ...(options.record !== undefined ? { record: options.record } : {}),
  });

  const provider = decision.provider_id ? getAuthzProvider(decision.provider_id) : null;
  let authorization: AuthzDecision;
  if (!provider) {
    authorization = deniedDecision(
      query,
      decision.provider_id ?? 'unresolved',
      'unresolved',
      `authorization unresolved: ${decision.rationale}`
    );
  } else {
    try {
      const verdict = provider.authorize(query, options.deps);
      // A provider returning a malformed decision must not escape the seam
      // boundary — coerce to a deny.
      authorization =
        verdict && typeof verdict.allowed === 'boolean'
          ? verdict
          : deniedDecision(
              query,
              provider.id,
              'provider_error',
              `authorization provider '${provider.id}' returned a malformed decision`
            );
    } catch (error) {
      authorization = deniedDecision(
        query,
        provider.id,
        'provider_error',
        `authorization provider '${provider.id}' failed closed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  recordAuthz({
    action: 'authz_decision',
    provider: authorization.provider,
    operation: query.operation.operationId,
    actor_id: query.principal.actor.id,
    allowed: authorization.allowed,
    reason_code: authorization.reasonCode,
  });
  return { authorization, decision };
}

/** Convenience: throw AuthzError on deny. */
export function assertAuthorizedWithPolicyEngine(
  query: AuthzQuery,
  options: AuthorizeWithPolicyEngineOptions = {}
): AuthzDecision {
  const { authorization } = authorizeWithPolicyEngine(query, options);
  if (!authorization.allowed) throw new AuthzError(authorization);
  return authorization;
}
