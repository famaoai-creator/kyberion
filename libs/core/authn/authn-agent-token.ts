/** Internal workload-token contract. Issuance is a primitive, not an admission or delivery API. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { agentActor, parseActorRef } from '../contracts/actor.js';
import { parseNhiId } from '../contracts/nhi-id.js';
import { getAgentIdentity, getAgentIdentityRevision } from '../agent/agent-identity.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { secretGuard } from '../secret/secret-guard.js';
import { defaultSurfaceViewerTierAccess } from '../surface/surface-mutation-guard.js';
import {
  AuthnError,
  authnEnvText,
  credentialToken,
  type AuthnProvider,
  type AuthnResolveDeps,
} from './authn-principal-resolver.js';

export const AGENT_TOKEN_ISSUER = 'kyberion-agent-token';
export const AGENT_TOKEN_PREFIX = 'kya1.';
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_TTL_SECONDS = 900;

export interface AgentTokenPayload {
  iss: typeof AGENT_TOKEN_ISSUER;
  sub: string;
  obo: string;
  exp: number;
  iat: number;
  jti: string;
  tenants: string[];
  identity_revision: number;
}

function deny(message: string): never {
  throw new AuthnError(401, 'unauthenticated', message);
}

function agentTokenKey(deps?: AuthnResolveDeps): Buffer | null {
  const envKey = authnEnvText(deps, 'KYBERION_AGENT_TOKEN_SECRET')?.trim();
  if (envKey) return Buffer.from(envKey, 'utf8');
  try {
    const doc = secretGuard.loadConnectionDocument('kyberion-agent-token') as
      { hmac_key?: string } | undefined;
    const key = doc?.hmac_key?.trim();
    return key ? Buffer.from(key, 'utf8') : null;
  } catch {
    return null;
  }
}

function sign(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(`${AGENT_TOKEN_PREFIX}${payloadB64}`).digest('base64url');
}

function activeIdentity(nhiId: string) {
  const parsed = parseNhiId(nhiId);
  if (!parsed || parsed.legacy) deny('agent token subject must be a canonical nhi_id');
  // Separate journal reads may observe different process generations. Never
  // pair an old record with a newly read revision (or retry a moving ledger).
  const revision = getAgentIdentityRevision(nhiId);
  const record = getAgentIdentity(nhiId);
  const revisionAfter = getAgentIdentityRevision(nhiId);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision !== revisionAfter) {
    deny('agent token identity revision changed during read');
  }
  if (
    !record ||
    record.nhi_id !== nhiId ||
    record.kind !== 'agent' ||
    record.lifecycle_status !== 'active'
  ) {
    deny('agent token identity must be a registered active agent');
  }
  if (!parseActorRef({ kind: 'human', id: record.accountable_human_id })) {
    deny('agent token identity requires a valid accountable human');
  }
  if ((record.affiliation.tenant_slug ?? null) !== parsed.tenant_slug) {
    deny('agent token identity tenant affiliation mismatch');
  }
  return { record, revision };
}

function validateTenants(value: unknown, affiliatedTenant: string | undefined): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1 ||
    Array.from(value).some(
      (tenant) =>
        typeof tenant !== 'string' || !isValidTenantSlug(tenant) || tenant !== affiliatedTenant
    )
  ) {
    deny('agent token tenant claims exceed identity affiliation');
  }
  return [...value];
}

function nowSeconds(deps?: AuthnResolveDeps): number {
  const now = Math.floor((deps?.now ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(now) || now < 1) deny('agent token clock invalid');
  return now;
}

/** No key creation, admission, human impersonation, or credential delivery occurs here. */
export function issueAgentToken(
  input: { nhiId: string; onBehalfOf?: string; ttlSeconds?: number; tenants?: string[] },
  deps?: AuthnResolveDeps
): { token: string; payload: AgentTokenPayload } {
  const { record, revision } = activeIdentity(input.nhiId);
  if (input.onBehalfOf !== undefined && input.onBehalfOf !== record.accountable_human_id) {
    deny('agent token accountable human mismatch');
  }
  const ttl = input.ttlSeconds === undefined ? MAX_TTL_SECONDS : input.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS)
    deny('agent token lifetime invalid');
  const tenants = validateTenants(
    input.tenants === undefined
      ? record.affiliation.tenant_slug
        ? [record.affiliation.tenant_slug]
        : []
      : input.tenants,
    record.affiliation.tenant_slug
  );
  const now = nowSeconds(deps);
  if (!Number.isSafeInteger(now + ttl) || now + ttl > 8_640_000_000_000)
    deny('agent token expiry invalid');
  const key = agentTokenKey(deps);
  if (!key) deny('no agent token signing key configured');
  const payload: AgentTokenPayload = {
    iss: AGENT_TOKEN_ISSUER,
    sub: record.nhi_id,
    obo: record.accountable_human_id,
    iat: now,
    exp: now + ttl,
    jti: randomBytes(16).toString('hex'),
    tenants,
    identity_revision: revision,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  if (activeIdentity(record.nhi_id).revision !== revision) {
    deny('agent token identity changed before signing');
  }
  const token = `${AGENT_TOKEN_PREFIX}${encoded}.${sign(encoded, key)}`;
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) deny('agent token too large');
  return { token, payload };
}

function verifiedPayload(token: string, key: Buffer, deps?: AuthnResolveDeps): AgentTokenPayload {
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) deny('agent token too large');
  const parts = token.slice(AGENT_TOKEN_PREFIX.length).split('.');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  ) {
    deny('agent token encoding invalid');
  }
  const [encoded, signature] = parts;
  const expected = sign(encoded, key);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    deny('agent token signature invalid');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    deny('agent token payload invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    deny('agent token payload invalid');
  const p = value as Record<string, unknown>;
  const fields = ['iss', 'sub', 'obo', 'exp', 'iat', 'jti', 'tenants', 'identity_revision'];
  if (
    Object.keys(p).length !== fields.length ||
    Object.keys(p).some((field) => !fields.includes(field)) ||
    p.iss !== AGENT_TOKEN_ISSUER ||
    typeof p.sub !== 'string' ||
    typeof p.obo !== 'string' ||
    typeof p.jti !== 'string' ||
    !/^[a-f0-9]{32}$/.test(p.jti) ||
    typeof p.iat !== 'number' ||
    !Number.isSafeInteger(p.iat) ||
    p.iat < 1 ||
    typeof p.exp !== 'number' ||
    !Number.isSafeInteger(p.exp) ||
    p.exp > 8_640_000_000_000 ||
    typeof p.identity_revision !== 'number' ||
    !Number.isSafeInteger(p.identity_revision) ||
    p.identity_revision < 1 ||
    !Array.isArray(p.tenants)
  )
    deny('agent token claims invalid');
  const now = nowSeconds(deps);
  if (p.iat > now || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > MAX_TTL_SECONDS) {
    deny('agent token lifetime invalid or expired');
  }
  return p as unknown as AgentTokenPayload;
}

export const agentTokenProvider: AuthnProvider = {
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
  canResolve(request) {
    // Recognized credentials must reach a rejecting resolver even when a key is absent.
    return credentialToken(request.credential).startsWith(AGENT_TOKEN_PREFIX)
      ? { eligible: true }
      : { eligible: false, unmet: ['credential is not a kya1. agent token'] };
  },
  resolve(request, deps) {
    const token = credentialToken(request.credential);
    if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null;
    const key = agentTokenKey(deps);
    if (!key) deny('no agent token verification key configured');
    const payload = verifiedPayload(token, key, deps);
    const { record, revision } = activeIdentity(payload.sub);
    if (payload.obo !== record.accountable_human_id || payload.identity_revision !== revision) {
      deny('agent token identity binding is stale or invalid');
    }
    const tenants = validateTenants(payload.tenants, record.affiliation.tenant_slug);
    if (
      request.serverTenant !== undefined &&
      (!isValidTenantSlug(request.serverTenant) || !tenants.includes(request.serverTenant))
    ) {
      deny('agent token does not authorize the requested server tenant');
    }
    if (activeIdentity(payload.sub).revision !== revision) {
      deny('agent token identity changed before resolution');
    }
    return {
      actor: agentActor(payload.sub, payload.obo),
      principalId: payload.sub,
      role: 'readonly',
      tenantSlugs: tenants,
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: defaultSurfaceViewerTierAccess('readonly'),
      source: 'agent',
      provider: 'agent-token',
      assurance: 'high',
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      claims: { jti: payload.jti, iat: payload.iat, identity_revision: payload.identity_revision },
    };
  },
};
