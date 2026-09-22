/**
 * authn-principal-resolver seam — authentication as a selectable provider.
 *
 * One seam (`authn-principal-resolver`), several interchangeable providers
 * (loopback-local, env-token, registry-token, agent-context, agent-token,
 * oidc-jwt, stub). Selection runs through the shared seam machinery
 * (seam-provider-selection.ts): caller-declared hard-filter eligibility →
 * mission pin → operator rule → purpose ranking → policy default, with every
 * decision on the audit chain.
 *
 * What a provider resolves is a {@link ResolvedPrincipal}: the canonical
 * ActorRef (actor.ts vocabulary — `user:<member>`, `kyberion://agent/...`,
 * `service:<slug>`) plus the scope claims the credential carries (role /
 * tenant / org / project / tier), projected losslessly into the existing
 * {@link SurfaceViewerScope} so current surfaces can adopt the seam without
 * a schema change.
 *
 * Fall-through vs fail-closed: `resolve` returns `null` when the credential
 * is not this provider's to judge (e.g. a bearer token absent from the
 * registry — an env token may still match). It throws {@link AuthnError}
 * when the credential IS its authority's but is invalid (expired, bad
 * signature, scope violation) — a bad credential must never fall through to
 * a weaker provider (downgrade).
 *
 * Provider plugins register through {@link registerAuthnProvider}; the
 * built-in set lives in `authn-providers.ts` and self-registers on import.
 */

import { auditChain } from './audit-chain.js';
import { isVitestProcess, getRegisteredEnvText } from './foundation/env.js';
import { createLogger } from './logger.js';
import type { ActorRef, ActorKind } from './actor.js';
import type { ChronosAccessRole, ChronosTokenRegistration } from './chronos-access-registry.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';
import type { MemberRegistryPathOptions } from './member-registry.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import {
  resolveSeamProviderDecision,
  type SeamProviderCandidate,
  type SeamProviderDecision,
} from './seam-provider-selection.js';

const logger = createLogger('authn-principal-resolver');

export const AUTHN_SEAM_ID = 'authn-principal-resolver';

// ---------------------------------------------------------------------------
// Request / credential model
// ---------------------------------------------------------------------------

export type AuthnCredentialType = 'bearer' | 'agent-token' | 'jwt' | 'none';

export interface AuthnCredential {
  type: AuthnCredentialType;
  token?: string;
}

export interface AuthnExecutionContext {
  /** KYBERION_PERSONA-style agent slug, or a canonical nhi_id via actorHint. */
  persona?: string;
  missionRole?: string;
  missionId?: string;
  /** A canonical actor id (`kyberion://agent/<org>/<slug>`) asserted by the runtime. */
  actorHint?: string;
}

export interface AuthnRequest {
  credential: AuthnCredential;
  /** Proven loopback origin — the framework adapter owns that proof. */
  loopback?: boolean;
  /**
   * Adapter-declared cap on the loopback grant: 'readonly' narrows the
   * local-dev owner role to a viewer (default 'localadmin').
   */
  loopbackRole?: 'readonly' | 'localadmin';
  /** Server-owned tenant binding for unregistered remote credentials. */
  serverTenant?: string;
  /**
   * In-process agent execution context (agent-context provider input). Its
   * mere presence is the adapter's assertion that this request originates
   * inside the runtime — a remote wire request must never carry one.
   */
  executionContext?: AuthnExecutionContext;
}

// ---------------------------------------------------------------------------
// Resolved principal
// ---------------------------------------------------------------------------

export type PrincipalAssurance = 'none' | 'low' | 'medium' | 'high';

export interface ResolvedPrincipal {
  /** Canonical actor vocabulary (actor.ts). */
  actor: ActorRef;
  /** Backward-compatible viewer principal label (SurfaceViewerScope.principalId). */
  principalId: string;
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: OsKnowledgeTier[];
  source: 'token' | 'loopback' | 'anonymous' | 'agent' | 'oidc';
  /** The provider id that resolved this principal. */
  provider: string;
  assurance: PrincipalAssurance;
  memberId?: string;
  registrationLabel?: string;
  claims?: Record<string, unknown>;
  expiresAt?: string;
}

/** Project a resolved principal onto the existing viewer-scope contract. */
export function toSurfaceViewerScope(principal: ResolvedPrincipal): SurfaceViewerScope {
  return {
    role: principal.role,
    tenantSlugs: principal.tenantSlugs,
    organizationIds: principal.organizationIds,
    projectIds: principal.projectIds,
    tierAccess: principal.tierAccess,
    source:
      principal.source === 'agent' || principal.source === 'oidc'
        ? 'token'
        : principal.source,
    principalId: principal.principalId,
    ...(principal.registrationLabel ? { registrationLabel: principal.registrationLabel } : {}),
    ...(principal.memberId ? { memberId: principal.memberId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AuthnErrorCode =
  | 'unrecognized_credential' // not this provider's credential — caller may fall through
  | 'unauthenticated' // this provider's credential, but invalid/expired — fail closed
  | 'scope_denied';

export class AuthnError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: AuthnErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AuthnError';
  }
}

// ---------------------------------------------------------------------------
// Provider contract + registry
// ---------------------------------------------------------------------------

export interface AuthnProviderCapabilities {
  credentialTypes: AuthnCredentialType[];
  /** Can resolve a proven-loopback request carrying no credential. */
  loopback: boolean;
  agentPrincipals: boolean;
  humanPrincipals: boolean;
  /** Federates to an external identity provider (OIDC-class). */
  externalIdp: boolean;
  /** Needs a network round-trip to resolve (remote JWKS, introspection). */
  requiresNetwork: boolean;
  /** Works with zero operator-side setup. */
  zeroConfig: boolean;
}

export interface AuthnResolveDeps {
  /** Env overlay (hermetic tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Pre-loaded chronos-access registrations; undefined = provider reads the registry. */
  registrations?: ChronosTokenRegistration[] | null;
  /**
   * Pre-resolved JWKS document for oidc-jwt (e.g. fetched ahead of time by a
   * surface that owns network egress). Without it the provider only consults
   * static JWKS config (KYBERION_OIDC_JWKS / _JWKS_PATH) — the resolve path
   * is synchronous and never touches the network itself.
   */
  jwks?: { keys: Array<Record<string, unknown>> };
  memberRegistry?: MemberRegistryPathOptions;
  /** Epoch-ms override for exp/nbf checks (tests). */
  now?: number;
}

export interface AuthnEligibility {
  eligible: boolean;
  /** Why this provider cannot judge the request (capability/config names). */
  unmet?: string[];
}

export interface AuthnProvider {
  id: string;
  capabilities: AuthnProviderCapabilities;
  /** Cheap eligibility for THIS request — feeds the seam hard filter. */
  canResolve(request: AuthnRequest, deps?: AuthnResolveDeps): AuthnEligibility;
  /**
   * Judge the credential. Returns null when the credential is not this
   * provider's to judge (eligible fall-through); throws AuthnError when it
   * is the provider's authority and rejects it.
   */
  resolve(request: AuthnRequest, deps?: AuthnResolveDeps): ResolvedPrincipal | null;
}

const providerRegistry = new Map<string, AuthnProvider>();

export function registerAuthnProvider(provider: AuthnProvider): void {
  providerRegistry.set(provider.id, provider);
}

export function getAuthnProvider(id: string): AuthnProvider | null {
  return providerRegistry.get(id) ?? null;
}

export function listAuthnProviders(restrictTo?: readonly string[]): AuthnProvider[] {
  const all = [...providerRegistry.values()];
  return restrictTo?.length ? all.filter((p) => restrictTo.includes(p.id)) : all;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ResolveAuthnPrincipalOptions {
  /** Seam purpose (`local-dev`, `remote-human`, `agent`, `federated`, `test`, …). */
  purpose?: string;
  /** Request facts operator rules may match on, e.g. { surface: 'concierge' }. */
  context?: Record<string, string>;
  /** Stable logical slot; enables mission pin reuse. */
  decisionKey?: string;
  pin?: boolean;
  /** Record the seam decision to the audit chain (default true). */
  record?: boolean;
  /** Restrict the candidate set (e.g. a surface allowlist). */
  providerIds?: readonly string[];
  deps?: AuthnResolveDeps;
}

export interface AuthnResolution {
  principal: ResolvedPrincipal;
  decision: SeamProviderDecision;
  /** Providers tried before the winner (id -> error message), for diagnostics. */
  attempts: Array<{ provider: string; outcome: 'resolved' | 'not-mine' | 'rejected'; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Audit — injectable sink, vitest-safe (mirrors nhi-actor-verification.ts)
// ---------------------------------------------------------------------------

export interface AuthnAuditEvent {
  action: 'authn_resolution';
  provider: string | null;
  result: 'resolved' | 'rejected' | 'unresolved';
  principal_id?: string;
  actor_id?: string;
  assurance?: PrincipalAssurance;
  reason?: string;
}

type AuthnAuditSink = (event: AuthnAuditEvent) => void;
let auditSinkOverride: AuthnAuditSink | null = null;

/** Test hook: observe authn outcomes without the real audit tree. */
export function setAuthnAuditSinkForTests(sink: AuthnAuditSink | null): void {
  auditSinkOverride = sink;
}

function recordAuthn(event: AuthnAuditEvent): void {
  try {
    if (auditSinkOverride) {
      auditSinkOverride(event);
      return;
    }
    if (isVitestProcess()) return;
    auditChain.record({
      agentId: event.actor_id ?? event.principal_id ?? 'authn-principal-resolver',
      action: 'authn_resolution',
      operation: `${AUTHN_SEAM_ID}/${event.provider ?? 'unresolved'}`,
      result: event.result === 'resolved' ? 'completed' : 'error',
      reason: event.reason,
      metadata: {
        provider: event.provider,
        principal_id: event.principal_id,
        assurance: event.assurance,
      },
    });
  } catch (error) {
    logger.warn(
      `[authn] audit append failed (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Resolve: seam decision → ranked fall-through → principal
// ---------------------------------------------------------------------------

/**
 * Resolve a request to a verified principal.
 *
 * The seam decision ranks eligible providers; each ranked provider is tried
 * in order. A provider returning `null` ("not my credential") falls through
 * to the next; an AuthnError is terminal for the whole chain only when every
 * remaining provider also cannot judge the credential — the FIRST hard
 * rejection wins, so a forged registry-shaped token can never drop down to a
 * weaker provider and succeed there.
 */
export function resolveAuthnPrincipal(
  request: AuthnRequest,
  options: ResolveAuthnPrincipalOptions = {}
): AuthnResolution {
  const providers = listAuthnProviders(options.providerIds);
  const candidates: SeamProviderCandidate[] = providers.map((provider) => {
    const eligibility = safeEligibility(provider, request, options.deps);
    return { id: provider.id, eligible: eligibility.eligible, unmet: eligibility.unmet };
  });
  const decision = resolveSeamProviderDecision({
    seam: AUTHN_SEAM_ID,
    candidates,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.decisionKey ? { decisionKey: options.decisionKey } : {}),
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
    ...(options.record !== undefined ? { record: options.record } : {}),
  });

  if (!decision.provider_id || decision.ranked.length === 0) {
    recordAuthn({
      action: 'authn_resolution',
      provider: null,
      result: 'unresolved',
      reason: decision.rationale,
    });
    throw new AuthnError(401, 'unauthenticated', `authentication unresolved: ${decision.rationale}`);
  }

  const attempts: AuthnResolution['attempts'] = [];
  let firstRejection: AuthnError | null = null;
  for (const providerId of decision.ranked) {
    const provider = getAuthnProvider(providerId);
    if (!provider) continue;
    try {
      const principal = provider.resolve(request, options.deps);
      if (!principal) {
        attempts.push({ provider: providerId, outcome: 'not-mine' });
        continue;
      }
      attempts.push({ provider: providerId, outcome: 'resolved' });
      recordAuthn({
        action: 'authn_resolution',
        provider: providerId,
        result: 'resolved',
        principal_id: principal.principalId,
        actor_id: principal.actor.id,
        assurance: principal.assurance,
      });
      return { principal, decision, attempts };
    } catch (error) {
      const authnError =
        error instanceof AuthnError
          ? error
          : new AuthnError(
              401,
              'unauthenticated',
              error instanceof Error ? error.message : String(error)
            );
      attempts.push({ provider: providerId, outcome: 'rejected', detail: authnError.message });
      // A provider that positively claims and rejects the credential ends the
      // chain: falling through would let a bad strong credential be retried
      // against weaker providers (downgrade).
      if (authnError.code !== 'unrecognized_credential') {
        firstRejection = firstRejection ?? authnError;
        break;
      }
      firstRejection = firstRejection ?? authnError;
    }
  }

  const finalError =
    firstRejection ??
    new AuthnError(401, 'unauthenticated', 'no provider accepted the credential');
  recordAuthn({
    action: 'authn_resolution',
    provider: decision.provider_id,
    result: 'rejected',
    reason: finalError.message,
  });
  throw finalError;
}

function safeEligibility(
  provider: AuthnProvider,
  request: AuthnRequest,
  deps?: AuthnResolveDeps
): AuthnEligibility {
  try {
    return provider.canResolve(request, deps);
  } catch (error) {
    return {
      eligible: false,
      unmet: [`eligibility check failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for providers
// ---------------------------------------------------------------------------

export function authnEnvText(
  deps: AuthnResolveDeps | undefined,
  name: string
): string | undefined {
  return getRegisteredEnvText(name, deps?.env ? { env: deps.env } : undefined);
}

export function credentialToken(credential: AuthnCredential): string {
  return credential.token?.trim() ?? '';
}

export function actorKindOf(principal: ResolvedPrincipal): ActorKind {
  return principal.actor.kind;
}
