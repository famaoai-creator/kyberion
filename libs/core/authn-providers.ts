/**
 * Built-in providers for the `authn-principal-resolver` seam.
 *
 * Importing this module self-registers every provider (the index barrel
 * pulls it in, so `@agent/core` consumers get the full set for free). Each
 * provider answers two questions separately:
 *
 *   canResolve — cheap eligibility feeding the seam hard filter
 *   resolve    — `null` when the credential is not this provider's to judge
 *                (fall through to the next ranked provider), `AuthnError`
 *                when it IS and is rejected (fail closed, no downgrade)
 *
 * Providers, weakest-to-strongest assurance:
 *   stub           — deterministic synthetic principal (tests only)
 *   env-token      — KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN
 *   loopback-local — proven loopback, no credential (local dev / operator)
 *   agent-context  — in-process agent identity (KYBERION_PERSONA /
 *                    MISSION_ROLE / actorHint) verified via NI-02 policy
 *   registry-token — chronos-access.json hashed registrations (FD-07)
 *   agent-token    — `kya1.` HMAC-signed workload credential bound to the
 *                    NI-01 identity ledger (SPIFFE-shaped nhi_id subject)
 *   oidc-jwt       — external IdP JWT, JWKS verified (RS256/ES256; HS256
 *                    only behind KYBERION_OIDC_ALLOW_HS256 for tests)
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
  type webcrypto,
} from 'node:crypto';

import { agentActor, humanActor, parseActorRef, serviceActor } from './actor.js';
import {
  findChronosTokenRegistration,
  matchesChronosToken,
  readChronosTokenRegistrations,
} from './chronos-access-registry.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';
import { isValidTenantSlug } from './entity-scope.js';
import { getRegisteredEnvBool } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { readTextFile } from './foundation/text.js';
import { getAgentIdentity, deriveAgentNhiId } from './agent-identity.js';
import { withExecutionContext } from './authority.js';
import { isValidMemberId } from './member-id-grammar.js';
import {
  NhiActorPolicyError,
  enforceNhiActorPolicy,
  resolveNhiActorMode,
} from './nhi-actor-verification.js';
import { parseNhiId } from './nhi-id.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { secretGuard } from './secret-guard.js';
import {
  defaultSurfaceViewerTierAccess,
  resolveSurfaceViewerTierAccess,
} from './surface-mutation-guard.js';
import {
  AuthnError,
  authnEnvText,
  credentialToken,
  registerAuthnProvider,
  type AuthnProvider,
  type AuthnRequest,
  type AuthnResolveDeps,
  type ResolvedPrincipal,
} from './authn-principal-resolver.js';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function envText(deps: AuthnResolveDeps | undefined, name: string): string | undefined {
  return authnEnvText(deps, name);
}

function envBool(deps: AuthnResolveDeps | undefined, name: string): boolean {
  return getRegisteredEnvBool(name, deps?.env ? { env: deps.env } : undefined) === true;
}

function scopedTenants(request: AuthnRequest): string[] | 'all' {
  const serverTenant = request.serverTenant?.trim();
  return serverTenant ? [serverTenant] : 'all';
}

function baseClaims(request: AuthnRequest, role: 'readonly' | 'localadmin') {
  return {
    role,
    tenantSlugs: scopedTenants(request),
    organizationIds: 'all' as const,
    projectIds: 'all' as const,
    tierAccess: defaultSurfaceViewerTierAccess(role),
  };
}

// ---------------------------------------------------------------------------
// stub — deterministic synthetic principal (tests / offline probes)
// ---------------------------------------------------------------------------

const stubProvider: AuthnProvider = {
  id: 'stub',
  capabilities: {
    credentialTypes: ['none'],
    loopback: true,
    agentPrincipals: true,
    humanPrincipals: true,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: true,
  },
  canResolve(request, deps) {
    // Self-gating: the stub is eligible only when the operator (or a test)
    // explicitly configured a stub principal — otherwise an unrecognized
    // credential could fall through to a synthetic identity (fail-open).
    if (!envText(deps, 'KYBERION_AUTHN_STUB_PRINCIPAL')?.trim()) {
      return { eligible: false, unmet: ['KYBERION_AUTHN_STUB_PRINCIPAL is not configured'] };
    }
    if (request.credential.type !== 'none') {
      // Even when configured, the stub never claims a presented credential —
      // a real-looking bearer/JWT must not resolve to a synthetic identity.
      return { eligible: false, unmet: ['stub resolves only credential-free requests'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    if (request.credential.type !== 'none') return null;
    const principalId =
      envText(deps, 'KYBERION_AUTHN_STUB_PRINCIPAL')?.trim() || 'stub:anonymous';
    return {
      actor: serviceActor('authn-stub'),
      principalId,
      ...baseClaims(request, 'readonly'),
      source: 'anonymous',
      provider: 'stub',
      assurance: 'none',
    };
  },
};

// ---------------------------------------------------------------------------
// loopback-local — proven loopback, no credential
// ---------------------------------------------------------------------------

const loopbackLocalProvider: AuthnProvider = {
  id: 'loopback-local',
  capabilities: {
    credentialTypes: ['none'],
    loopback: true,
    agentPrincipals: false,
    humanPrincipals: true,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: true,
  },
  canResolve(request) {
    const hasCredential = request.credential.type !== 'none' && credentialToken(request.credential);
    if (!request.loopback || hasCredential) {
      return { eligible: false, unmet: ['requires a credential-free proven-loopback request'] };
    }
    return { eligible: true };
  },
  resolve(request) {
    if (!request.loopback) return null;
    // The adapter may narrow the loopback grant (e.g. a surface that only
    // trusts loopback viewers); default keeps the local-dev owner role.
    const role = request.loopbackRole === 'readonly' ? 'readonly' : 'localadmin';
    return {
      actor: humanActor('owner'),
      principalId: 'user:owner',
      ...baseClaims(request, role),
      source: 'loopback',
      provider: 'loopback-local',
      assurance: 'medium',
    };
  },
};

// ---------------------------------------------------------------------------
// env-token — KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN
// ---------------------------------------------------------------------------

const envTokenProvider: AuthnProvider = {
  id: 'env-token',
  capabilities: {
    credentialTypes: ['bearer'],
    loopback: false,
    agentPrincipals: false,
    humanPrincipals: true,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: false,
  },
  canResolve(request, deps) {
    if (request.credential.type !== 'bearer' || !credentialToken(request.credential)) {
      return { eligible: false, unmet: ['requires a bearer credential'] };
    }
    if (!envText(deps, 'KYBERION_API_TOKEN') && !envText(deps, 'KYBERION_LOCALADMIN_TOKEN')) {
      return { eligible: false, unmet: ['no KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN configured'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    const token = credentialToken(request.credential);
    const role = matchesChronosToken(token, envText(deps, 'KYBERION_LOCALADMIN_TOKEN'))
      ? 'localadmin'
      : matchesChronosToken(token, envText(deps, 'KYBERION_API_TOKEN'))
        ? 'readonly'
        : null;
    if (!role) return null; // not ours — a registry/OIDC token may still match
    if (!request.loopback && !request.serverTenant?.trim()) {
      throw new AuthnError(
        403,
        'scope_denied',
        'Remote viewer access requires server-side tenant scope.'
      );
    }
    return {
      actor: serviceActor(`env-${role}-token`),
      principalId: `service:env-${role}-token`,
      ...baseClaims(request, role),
      source: 'token',
      provider: 'env-token',
      assurance: 'low',
    };
  },
};

// ---------------------------------------------------------------------------
// registry-token — chronos-access.json hashed registrations (FD-07)
// ---------------------------------------------------------------------------

function loadRegistrations(deps?: AuthnResolveDeps) {
  if (deps?.registrations !== undefined) return deps.registrations;
  return withExecutionContext('sovereign_concierge', () => readChronosTokenRegistrations());
}

const registryTokenProvider: AuthnProvider = {
  id: 'registry-token',
  capabilities: {
    credentialTypes: ['bearer'],
    loopback: false,
    agentPrincipals: false,
    humanPrincipals: true,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: false,
  },
  canResolve(request, deps) {
    if (request.credential.type !== 'bearer' || !credentialToken(request.credential)) {
      return { eligible: false, unmet: ['requires a bearer credential'] };
    }
    try {
      const registrations = loadRegistrations(deps);
      if (!registrations?.length) {
        return { eligible: false, unmet: ['chronos-access registry is empty or unavailable'] };
      }
    } catch {
      return { eligible: false, unmet: ['chronos-access registry is unreadable'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    const token = credentialToken(request.credential);
    let registrations;
    try {
      registrations = loadRegistrations(deps);
    } catch (error) {
      throw new AuthnError(
        401,
        'unauthenticated',
        `viewer token registry unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const registration = registrations?.length
      ? findChronosTokenRegistration(token, [...registrations])
      : null;
    if (!registration) return null; // not ours — env-token may still match

    const memberId = registration.member_id?.trim();
    const principalId = registration.label || `token:${registration.token_hash.slice(0, 12)}`;
    let tierAccess: OsKnowledgeTier[];
    try {
      tierAccess = resolveSurfaceViewerTierAccess(registration.role, registration.tier_access);
    } catch (error) {
      throw new AuthnError(
        403,
        'scope_denied',
        error instanceof Error ? error.message : 'viewer tier scope denied'
      );
    }
    return {
      actor: memberId ? humanActor(memberId) : serviceActor('chronos-token'),
      principalId,
      role: registration.role,
      tenantSlugs: [...registration.tenant_slugs],
      organizationIds: registration.organization_ids ? [...registration.organization_ids] : 'all',
      projectIds: registration.project_ids ? [...registration.project_ids] : 'all',
      tierAccess,
      source: 'token',
      provider: 'registry-token',
      assurance: 'high',
      ...(memberId ? { memberId } : {}),
      ...(registration.label ? { registrationLabel: registration.label } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// agent-context — in-process agent identity via NI-02 policy
// ---------------------------------------------------------------------------

const agentContextProvider: AuthnProvider = {
  id: 'agent-context',
  capabilities: {
    credentialTypes: ['none'],
    loopback: false,
    agentPrincipals: true,
    humanPrincipals: false,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: true,
  },
  canResolve(request, deps) {
    if (request.credential.type !== 'none' && credentialToken(request.credential)) {
      return { eligible: false, unmet: ['requires a credential-free request'] };
    }
    // The provider is for IN-PROCESS agents: the adapter must attach an
    // executionContext object (even empty) as the runtime assertion that this
    // is not a remote request. Without it, ambient KYBERION_PERSONA /
    // MISSION_ROLE process env must never authenticate a wire request.
    if (!request.executionContext) {
      return { eligible: false, unmet: ['requires an in-process executionContext assertion'] };
    }
    const ctx = request.executionContext;
    const hinted =
      ctx.actorHint?.trim() ||
      ctx.persona?.trim() ||
      ctx.missionRole?.trim() ||
      envText(deps, 'KYBERION_PERSONA')?.trim() ||
      envText(deps, 'MISSION_ROLE')?.trim();
    if (!hinted) {
      return { eligible: false, unmet: ['no agent identity hint (persona/missionRole/actorHint)'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    if (!request.executionContext) return null;
    const ctx = request.executionContext;
    const hint =
      ctx.actorHint?.trim() ||
      ctx.persona?.trim() ||
      ctx.missionRole?.trim() ||
      envText(deps, 'KYBERION_PERSONA')?.trim() ||
      envText(deps, 'MISSION_ROLE')?.trim() ||
      '';
    const nhiId = parseNhiId(hint) ? hint : deriveAgentNhiId(hint);
    if (!nhiId) return null;

    const mode = resolveNhiActorMode();
    try {
      enforceNhiActorPolicy(nhiId, 'authn.agent-context');
    } catch (error) {
      if (error instanceof NhiActorPolicyError) {
        throw new AuthnError(401, 'unauthenticated', error.message);
      }
      throw error;
    }
    const record = getAgentIdentity(nhiId);
    // A KNOWN-bad identity is denied at the authentication boundary in every
    // NI-02 mode — 'warn'/'off' only soften the unregistered-identity case.
    if (record && (record.lifecycle_status === 'suspended' || record.lifecycle_status === 'retired')) {
      throw new AuthnError(
        401,
        'unauthenticated',
        `agent identity ${nhiId} is ${record.lifecycle_status}`
      );
    }
    const onBehalfOf =
      record?.accountable_human_id &&
      parseActorRef({ kind: 'human', id: record.accountable_human_id })
        ? record.accountable_human_id
        : undefined;
    return {
      actor: agentActor(nhiId, onBehalfOf),
      principalId: nhiId,
      role: 'readonly',
      tenantSlugs: scopedTenants(request),
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: defaultSurfaceViewerTierAccess('readonly'),
      source: 'agent',
      provider: 'agent-context',
      assurance: mode === 'enforce' ? 'medium' : mode === 'warn' ? 'low' : 'none',
      claims: { nhi_actor_mode: mode, nhi_verdict: record ? record.lifecycle_status : 'unregistered' },
    };
  },
};

// ---------------------------------------------------------------------------
// agent-token — kya1.<b64url payload>.<b64url HMAC-SHA256> workload credential
// ---------------------------------------------------------------------------

export const AGENT_TOKEN_ISSUER = 'kyberion-agent-token';
const AGENT_TOKEN_PREFIX = 'kya1.';
const AGENT_TOKEN_SECRET_DOC = 'kyberion-agent-token';

export interface AgentTokenPayload {
  iss: typeof AGENT_TOKEN_ISSUER;
  sub: string; // canonical nhi_id
  obo?: string; // on-behalf-of human actor id (user:<member>)
  exp: number; // epoch seconds
  iat: number;
  jti: string;
  tenants?: string[];
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlJson(value: unknown): string {
  return b64urlEncode(JSON.stringify(value));
}

function agentTokenKey(deps?: AuthnResolveDeps): Buffer | null {
  const envKey = envText(deps, 'KYBERION_AGENT_TOKEN_SECRET')?.trim();
  if (envKey) return Buffer.from(envKey, 'utf8');
  try {
    const doc = secretGuard.loadConnectionDocument(AGENT_TOKEN_SECRET_DOC) as
      | { hmac_key?: string }
      | undefined;
    const key = doc?.hmac_key?.trim();
    return key ? Buffer.from(key, 'utf8') : null;
  } catch {
    return null;
  }
}

function signAgentTokenPayload(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(`${AGENT_TOKEN_PREFIX}${payloadB64}`).digest('base64url');
}

/**
 * Issue a signed workload credential for a registered agent identity.
 * The subject must exist in the NI-01 ledger and be non-retired —
 * credentials are never minted for identities the registry does not know.
 */
export function issueAgentToken(
  input: {
    nhiId: string;
    onBehalfOf?: string;
    ttlSeconds?: number;
    tenants?: string[];
  },
  deps?: AuthnResolveDeps
): { token: string; payload: AgentTokenPayload } {
  const nhiId = input.nhiId.trim();
  if (!parseNhiId(nhiId)) {
    throw new AuthnError(401, 'unauthenticated', `agent token subject is not a valid nhi_id`);
  }
  const record = getAgentIdentity(nhiId);
  if (!record) {
    throw new AuthnError(401, 'unauthenticated', `agent identity ${nhiId} is not registered`);
  }
  if (record.lifecycle_status === 'retired' || record.lifecycle_status === 'suspended') {
    throw new AuthnError(
      401,
      'unauthenticated',
      `agent identity ${nhiId} is ${record.lifecycle_status}`
    );
  }
  const key = agentTokenKey(deps);
  if (!key) {
    throw new AuthnError(
      401,
      'unauthenticated',
      'no agent token signing key (KYBERION_AGENT_TOKEN_SECRET or secret-guard kyberion-agent-token)'
    );
  }
  const nowSec = Math.floor((deps?.now ?? Date.now()) / 1000);
  const payload: AgentTokenPayload = {
    iss: AGENT_TOKEN_ISSUER,
    sub: nhiId,
    ...(input.onBehalfOf ? { obo: input.onBehalfOf } : {}),
    iat: nowSec,
    exp: nowSec + Math.max(1, input.ttlSeconds ?? 900),
    jti: createHash('sha256')
      .update(`${nhiId}:${nowSec}:${Math.random()}`)
      .digest('hex')
      .slice(0, 24),
    ...(input.tenants?.length ? { tenants: [...input.tenants] } : {}),
  };
  const payloadB64 = b64urlJson(payload);
  return { token: `${AGENT_TOKEN_PREFIX}${payloadB64}.${signAgentTokenPayload(payloadB64, key)}`, payload };
}

function parseAgentToken(token: string): { payloadB64: string; signature: string; payload: AgentTokenPayload } | null {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const body = token.slice(AGENT_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  return { payloadB64, signature, payload };
}

const agentTokenProvider: AuthnProvider = {
  id: 'agent-token',
  capabilities: {
    credentialTypes: ['agent-token', 'bearer'],
    loopback: false,
    agentPrincipals: true,
    humanPrincipals: false,
    externalIdp: false,
    requiresNetwork: false,
    zeroConfig: false,
  },
  canResolve(request, deps) {
    const token = credentialToken(request.credential);
    if (!token.startsWith(AGENT_TOKEN_PREFIX)) {
      return { eligible: false, unmet: ['credential is not a kya1. agent token'] };
    }
    if (!agentTokenKey(deps)) {
      return { eligible: false, unmet: ['no agent token verification key configured'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    const token = credentialToken(request.credential);
    const parsed = parseAgentToken(token);
    if (!parsed) return null;
    const key = agentTokenKey(deps);
    if (!key) return null;
    const expected = signAgentTokenPayload(parsed.payloadB64, key);
    const sigOk =
      parsed.signature.length === expected.length &&
      timingSafeEqual(Buffer.from(parsed.signature), Buffer.from(expected));
    if (!sigOk) {
      throw new AuthnError(401, 'unauthenticated', 'agent token signature invalid');
    }
    const { payload } = parsed;
    if (payload.iss !== AGENT_TOKEN_ISSUER) {
      throw new AuthnError(401, 'unauthenticated', 'agent token issuer mismatch');
    }
    const nowSec = Math.floor((deps?.now ?? Date.now()) / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      throw new AuthnError(401, 'unauthenticated', 'agent token expired');
    }
    if (!parseNhiId(payload.sub)) {
      throw new AuthnError(401, 'unauthenticated', 'agent token subject is not a valid nhi_id');
    }
    const record = getAgentIdentity(payload.sub);
    if (!record || record.lifecycle_status === 'retired' || record.lifecycle_status === 'suspended') {
      throw new AuthnError(
        401,
        'unauthenticated',
        `agent identity ${payload.sub} is ${record ? record.lifecycle_status : 'unregistered'}`
      );
    }
    const tenants = (payload.tenants ?? []).filter((slug) => isValidTenantSlug(slug));
    const onBehalfOf =
      payload.obo && parseActorRef({ kind: 'human', id: payload.obo }) ? payload.obo : undefined;
    return {
      actor: agentActor(payload.sub, onBehalfOf ?? record.accountable_human_id),
      principalId: payload.sub,
      role: 'readonly',
      tenantSlugs: tenants.length ? tenants : request.serverTenant?.trim() ? [request.serverTenant.trim()] : [],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: defaultSurfaceViewerTierAccess('readonly'),
      source: 'agent',
      provider: 'agent-token',
      assurance: 'high',
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      claims: { jti: payload.jti, iat: payload.iat },
    };
  },
};

// ---------------------------------------------------------------------------
// oidc-jwt — external IdP JWT verified against configured JWKS
// ---------------------------------------------------------------------------

interface OidcConfig {
  issuer?: string;
  audience?: string;
  jwks?: { keys: JsonWebKeyLike[] };
}

/**
 * Minimal JWK shape (node:crypto's JsonWebKey type is not exported on every
 * supported @types/node version). `createPublicKey` accepts it via the
 * `format: 'jwk'` object overload.
 */
interface JsonWebKeyLike {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  k?: string;
  [key: string]: unknown;
}

/**
 * JWKS sources in priority order: pre-resolved `deps.jwks` (a surface that
 * owns network egress fetched it ahead of time) → KYBERION_OIDC_JWKS inline
 * JSON → KYBERION_OIDC_JWKS_PATH file. The resolve path is synchronous and
 * never touches the network itself — remote IdP federation plugs in by
 * pre-fetching into `deps.jwks` (KYBERION_OIDC_JWKS_URL documents intent).
 */
function resolveOidcJwks(deps?: AuthnResolveDeps): { keys: JsonWebKeyLike[] } | null {
  if (deps?.jwks && Array.isArray(deps.jwks.keys) && deps.jwks.keys.length) {
    return { keys: deps.jwks.keys as JsonWebKeyLike[] };
  }
  const inline = envText(deps, 'KYBERION_OIDC_JWKS')?.trim();
  if (inline) {
    try {
      const parsed = parseSafeJsonInput(inline, 'KYBERION_OIDC_JWKS');
      return parsed && typeof parsed === 'object' && Array.isArray((parsed as { keys?: unknown }).keys)
        ? (parsed as { keys: JsonWebKeyLike[] })
        : null;
    } catch {
      return null;
    }
  }
  const jwksPath = envText(deps, 'KYBERION_OIDC_JWKS_PATH')?.trim();
  if (jwksPath) {
    try {
      const safePath = assertSafeRepositoryPath(jwksPath);
      if (!safeExistsSync(safePath)) return null;
      const parsed = parseSafeJsonInput(readTextFile(safePath), 'KYBERION_OIDC_JWKS_PATH');
      return parsed && typeof parsed === 'object' && Array.isArray((parsed as { keys?: unknown }).keys)
        ? (parsed as { keys: JsonWebKeyLike[] })
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function decodeJwtPart<T = Record<string, unknown>>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

const oidcJwtProvider: AuthnProvider = {
  id: 'oidc-jwt',
  capabilities: {
    credentialTypes: ['jwt', 'bearer'],
    loopback: false,
    agentPrincipals: false,
    humanPrincipals: true,
    externalIdp: true,
    requiresNetwork: false, // remote JWKS only via injected fetcher
    zeroConfig: false,
  },
  canResolve(request, deps) {
    const token = credentialToken(request.credential);
    if (!JWT_SHAPE.test(token) || token.startsWith(AGENT_TOKEN_PREFIX)) {
      return { eligible: false, unmet: ['credential is not a JWT'] };
    }
    // Issuer binding is mandatory: without it the provider would claim every
    // JWT-shaped token (hard-failing env/registry credentials that merely
    // look like JWTs) and accept any issuer the keys cover.
    if (!envText(deps, 'KYBERION_OIDC_ISSUER')?.trim()) {
      return { eligible: false, unmet: ['KYBERION_OIDC_ISSUER is not configured'] };
    }
    if (!resolveOidcJwks(deps)?.keys?.length) {
      return { eligible: false, unmet: ['no JWKS source configured'] };
    }
    return { eligible: true };
  },
  resolve(request, deps) {
    const token = credentialToken(request.credential);
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = decodeJwtPart<{ alg?: string; kid?: string }>(parts[0]!);
    const claims = decodeJwtPart<Record<string, unknown>>(parts[1]!);
    if (!header?.alg || !claims) {
      throw new AuthnError(401, 'unauthenticated', 'malformed JWT');
    }

    const issuer = envText(deps, 'KYBERION_OIDC_ISSUER')?.trim() ?? '';
    if (claims.iss !== issuer) return null; // another authority's token

    const config: OidcConfig = {
      issuer,
      audience: envText(deps, 'KYBERION_OIDC_AUDIENCE')?.trim(),
      jwks: resolveOidcJwks(deps) ?? undefined,
    };
    if (!config.jwks?.keys?.length) {
      throw new AuthnError(401, 'unauthenticated', 'no OIDC JWKS configured');
    }

    verifyJwtSignature(token, header, claims, config, deps);
    return claimsToPrincipal(claims, request);
  },
};

function verifyJwtSignature(
  token: string,
  header: { alg?: string; kid?: string },
  claims: Record<string, unknown>,
  config: OidcConfig,
  deps?: AuthnResolveDeps
): void {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  const data = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64 ?? '', 'base64url');
  const alg = header.alg!;

  const fail = (msg: string): never => {
    throw new AuthnError(401, 'unauthenticated', msg);
  };

  // Signature first: claims on an unverified token must not influence the
  // verdict (and differentiated errors before signature cost become a probe
  // oracle for forged tokens).
  const keys = config.jwks!.keys.filter(
    (key) =>
      (!header.kid || key.kid === header.kid) &&
      (!key.use || key.use === 'sig') &&
      (!key.alg || key.alg === alg)
  );

  let signatureOk = false;
  if (alg === 'RS256' || alg === 'ES256') {
    const kty = alg === 'RS256' ? 'RSA' : 'EC';
    for (const jwk of keys) {
      if (jwk.kty !== kty) continue;
      try {
        const keyObject = createPublicKey({
          key: jwk as webcrypto.JsonWebKey,
          format: 'jwk',
        });
        const ok =
          alg === 'RS256'
            ? verify('RSA-SHA256', Buffer.from(data), keyObject, signature)
            : verify(
                'sha256',
                Buffer.from(data),
                { key: keyObject, dsaEncoding: 'ieee-p1363' },
                signature
              );
        if (ok) {
          signatureOk = true;
          break;
        }
      } catch {
        // try next key
      }
    }
  } else if (alg === 'HS256') {
    if (!envBool(deps, 'KYBERION_OIDC_ALLOW_HS256')) {
      fail('HS256 is disabled (KYBERION_OIDC_ALLOW_HS256)');
    }
    for (const jwk of keys) {
      if (jwk.kty !== 'oct' || typeof jwk.k !== 'string') continue;
      const expected = createHmac('sha256', Buffer.from(jwk.k, 'base64url'))
        .update(data)
        .digest();
      if (expected.length === signature.length && timingSafeEqual(expected, signature)) {
        signatureOk = true;
        break;
      }
    }
  } else {
    fail(`unsupported JWT alg '${alg}'`);
  }
  if (!signatureOk) fail('JWT signature verification failed');

  const nowSec = Math.floor((deps?.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) fail('JWT expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec) fail('JWT not yet valid');
  if (config.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.audience)) fail('JWT audience mismatch');
  }
}

function claimsToPrincipal(
  claims: Record<string, unknown>,
  request: AuthnRequest
): ResolvedPrincipal {
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const memberIdClaim =
    typeof claims.member_id === 'string' && isValidMemberId(claims.member_id.trim())
      ? claims.member_id.trim()
      : undefined;

  let actor;
  let memberId: string | undefined;
  if (memberIdClaim) {
    actor = humanActor(memberIdClaim);
    memberId = memberIdClaim;
  } else if (sub.startsWith('user:') && isValidMemberId(sub.slice(5))) {
    actor = humanActor(sub.slice(5));
    memberId = sub.slice(5);
  } else {
    // External subject that is not a known member: keep a grammar-valid,
    // unregistered human actor id (member-membership authz will deny it —
    // fail closed by default).
    const digest = createHash('sha256').update(sub || 'anonymous').digest('hex').slice(0, 10);
    actor = humanActor(`ext-${digest}`);
  }

  const roleClaim = claims.kyberion_role ?? claims.role;
  const role = roleClaim === 'localadmin' ? 'localadmin' : 'readonly';
  const tenantClaims = Array.isArray(claims.kyberion_tenants)
    ? claims.kyberion_tenants
        .filter((slug): slug is string => typeof slug === 'string')
        .map((slug) => slug.trim())
        .filter((slug) => isValidTenantSlug(slug))
    : [];
  const orgClaims = Array.isArray(claims.kyberion_orgs)
    ? claims.kyberion_orgs.filter((v): v is string => typeof v === 'string')
    : null;
  const projectClaims = Array.isArray(claims.kyberion_projects)
    ? claims.kyberion_projects.filter((v): v is string => typeof v === 'string')
    : null;
  const tierClaims = Array.isArray(claims.kyberion_tiers)
    ? (claims.kyberion_tiers.filter(
        (tier): tier is OsKnowledgeTier =>
          tier === 'public' || tier === 'confidential' || tier === 'personal'
      ) as OsKnowledgeTier[])
    : undefined;

  let tierAccess: OsKnowledgeTier[];
  try {
    tierAccess = resolveSurfaceViewerTierAccess(role, tierClaims);
  } catch (error) {
    throw new AuthnError(
      403,
      'scope_denied',
      error instanceof Error ? error.message : 'viewer tier scope denied'
    );
  }

  return {
    actor,
    principalId: sub || actor.id,
    role,
    // Fail closed: without tenant claims the principal sees only the
    // server-bound tenant, and without one of those, nothing.
    tenantSlugs: tenantClaims.length
      ? tenantClaims
      : request.serverTenant?.trim()
        ? [request.serverTenant.trim()]
        : [],
    organizationIds: orgClaims ?? 'all',
    projectIds: projectClaims ?? 'all',
    tierAccess,
    source: 'oidc',
    provider: 'oidc-jwt',
    assurance: 'high',
    ...(memberId ? { memberId } : {}),
    expiresAt:
      typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : undefined,
    claims: {
      iss: typeof claims.iss === 'string' ? claims.iss : undefined,
      jti: typeof claims.jti === 'string' ? claims.jti : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

let registered = false;

/** Idempotent — safe to call from composition roots and tests. */
export function registerBuiltinAuthnProviders(): void {
  if (registered) return;
  registered = true;
  for (const provider of [
    stubProvider,
    loopbackLocalProvider,
    envTokenProvider,
    registryTokenProvider,
    agentContextProvider,
    agentTokenProvider,
    oidcJwtProvider,
  ]) {
    registerAuthnProvider(provider);
  }
}

registerBuiltinAuthnProviders();

export const BUILTIN_AUTHN_PROVIDER_IDS = [
  'stub',
  'loopback-local',
  'env-token',
  'registry-token',
  'agent-context',
  'agent-token',
  'oidc-jwt',
] as const;
