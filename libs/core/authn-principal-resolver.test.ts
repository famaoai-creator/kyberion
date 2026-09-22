import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';

/**
 * Hermetic tests for the authn-principal-resolver seam. Mirrors
 * seam-provider-selection.test.ts: the seam decision machinery is real (real
 * governed policy JSONs), while operator rules, provider pins and the audit
 * chain are replaced with in-memory doubles. Provider inputs that touch
 * durable state (chronos registrations, the agent-identity journal, env) are
 * injected via AuthnResolveDeps or repointed under active/shared/tmp/.
 */

const pins = new Map<
  string,
  { seam: string; provider_id: string; purpose?: string; pinnedAt: string; by: string }
>();
const record = vi.fn();
const overlay: {
  rules: Array<Record<string, unknown>>;
  overrides: Record<string, Record<string, { traits: Record<string, number> }>>;
} = { rules: [], overrides: {} };

vi.mock('./seam-selection-rules.js', () => ({
  matchSeamSelectionRule: (
    seam: string,
    request: { purpose?: string; context?: Record<string, string> }
  ) =>
    (
      overlay.rules as Array<{
        seam: string;
        when: { purpose?: string; context?: Record<string, string> };
      }>
    ).find(
      (rule) =>
        rule.seam === seam &&
        (!rule.when.purpose || rule.when.purpose === request.purpose) &&
        Object.entries(rule.when.context ?? {}).every(
          ([k, v]) => request.context?.[k] === v
        )
    ) ?? null,
  getSeamTraitOverrides: (seam: string) => overlay.overrides[seam] ?? {},
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: (seam: string, key: string) => pins.get(`${seam}:${key}`) ?? null,
  pinSeamProviderDecision: (
    seam: string,
    key: string,
    providerId: string,
    purpose?: string
  ) => {
    const entry = {
      seam,
      provider_id: providerId,
      ...(purpose ? { purpose } : {}),
      pinnedAt: '2026-09-22T00:00:00.000Z',
      by: 'test',
    };
    pins.set(`${seam}:${key}`, entry);
    return entry;
  },
}));

const {
  AuthnError,
  listAuthnProviders,
  resolveAuthnPrincipal,
  toSurfaceViewerScope,
} = await import('./authn-principal-resolver.js');
const {
  AGENT_TOKEN_ISSUER,
  BUILTIN_AUTHN_PROVIDER_IDS,
  issueAgentToken,
} = await import('./authn-providers.js');
const {
  activateAgentIdentity,
  issueAgentIdentity,
  resetAgentIdentityServiceForTests,
  suspendAgentIdentity,
} = await import('./agent-identity.js');
const { withExecutionContext } = await import('./authority.js');
const { clearNhiActorVerificationCache } = await import('./nhi-actor-verification.js');

const TMP_DIR = `active/shared/tmp/authn-seam-tests-${process.pid}`;
const AGENT_SECRET = 'test-agent-token-secret';
const STUB_ENV = { KYBERION_AUTHN_STUB_PRINCIPAL: 'stub:tester' };
let counter = 0;

function cleanupTmpDir(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  counter += 1;
  pins.clear();
  record.mockClear();
  overlay.rules = [];
  overlay.overrides = {};
  vi.stubEnv('MISSION_ID', '');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'off');
  resetAgentIdentityServiceForTests(`${TMP_DIR}/agent-identities-${counter}.jsonl`);
  clearNhiActorVerificationCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearNhiActorVerificationCache();
  resetAgentIdentityServiceForTests();
});

afterAll(() => cleanupTmpDir());

function seedActiveAgent(slug: string): string {
  const record_ = withExecutionContext('mission_controller', () => {
    const issued = issueAgentIdentity({
      kind: 'agent',
      organizationId: 'default',
      slug,
      accountableHumanId: 'user:founder',
    });
    return activateAgentIdentity(issued.nhi_id);
  });
  return record_.nhi_id;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function expectAuthnRejection(
  fn: () => unknown,
  status: 401 | 403,
  code?: string
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthnError);
    expect((error as AuthnError).status).toBe(status);
    if (code) expect((error as AuthnError).code).toBe(code);
    return;
  }
  throw new Error('expected AuthnError, but the call resolved');
}

// ---------------------------------------------------------------------------
// registry / selection
// ---------------------------------------------------------------------------

describe('authn seam — registry and selection', () => {
  it('registers all seven built-in providers', () => {
    expect(listAuthnProviders().map((p) => p.id).sort()).toEqual(
      [...BUILTIN_AUTHN_PROVIDER_IDS].sort()
    );
    expect(BUILTIN_AUTHN_PROVIDER_IDS).toContain('stub');
    expect(BUILTIN_AUTHN_PROVIDER_IDS).toContain('oidc-jwt');
  });

  it('fails closed when no provider can judge the credential', () => {
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'mystery' } },
          { deps: { env: {}, registrations: [] } }
        ),
      401
    );
  });

  it('honors an operator rule over the seam default', () => {
    overlay.rules = [
      {
        seam: 'authn-principal-resolver',
        when: {},
        prefer: ['env-token'],
        rule_id: 'rule-test',
        set_at: '2026-09-22T00:00:00.000Z',
        set_by: 'test',
      },
    ];
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'api-secret' }, serverTenant: 'default' },
      { deps: { env: { KYBERION_API_TOKEN: 'api-secret' }, registrations: [
        { token_hash: hashToken('api-secret'), role: 'localadmin', tenant_slugs: ['default'] },
      ] } }
    );
    expect(resolution.decision.provider_id).toBe('env-token');
    expect(resolution.principal.provider).toBe('env-token');
  });
});

// ---------------------------------------------------------------------------
// stub
// ---------------------------------------------------------------------------

describe('authn provider — stub', () => {
  it('is ineligible unless KYBERION_AUTHN_STUB_PRINCIPAL is configured (no fail-open)', () => {
    // An unrecognized bearer must NOT silently degrade to a synthetic stub
    // principal — with the stub unconfigured there is no eligible provider.
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'unknown-token' }, serverTenant: 'default' },
          { purpose: 'test', deps: { env: {}, registrations: [] } }
        ),
      401
    );
  });

  it('resolves a synthetic principal when explicitly configured', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'none' }, serverTenant: 'default' },
      { purpose: 'test', deps: { env: STUB_ENV } }
    );
    expect(resolution.principal.provider).toBe('stub');
    expect(resolution.principal.principalId).toBe('stub:tester');
    expect(resolution.principal.assurance).toBe('none');
    expect(resolution.principal.actor.kind).toBe('service');
  });

  it('never claims a presented credential even when configured', () => {
    // A leftover KYBERION_AUTHN_STUB_PRINCIPAL must not turn the stub into a
    // universal acceptor for bearer tokens.
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'forged' }, serverTenant: 'default' },
          { purpose: 'test', deps: { env: STUB_ENV, registrations: [] } }
        ),
      401
    );
  });
});

// ---------------------------------------------------------------------------
// loopback-local
// ---------------------------------------------------------------------------

describe('authn provider — loopback-local', () => {
  it('resolves a credential-free proven-loopback request to the owner principal', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'none' }, loopback: true, serverTenant: 'default' },
      { deps: { env: {} } }
    );
    expect(resolution.principal).toMatchObject({
      provider: 'loopback-local',
      principalId: 'user:owner',
      role: 'localadmin',
      tenantSlugs: ['default'],
      assurance: 'medium',
    });
    expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:owner' });
  });

  it('honors an adapter-declared loopbackRole downgrade to readonly', () => {
    const resolution = resolveAuthnPrincipal(
      {
        credential: { type: 'none' },
        loopback: true,
        loopbackRole: 'readonly',
        serverTenant: 'default',
      },
      { deps: { env: {} } }
    );
    expect(resolution.principal.role).toBe('readonly');
  });

  it('does not resolve a non-loopback credential-free request', () => {
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'none' }, serverTenant: 'default' },
          { deps: { env: {} } }
        ),
      401
    );
  });
});

// ---------------------------------------------------------------------------
// env-token / registry-token
// ---------------------------------------------------------------------------

describe('authn providers — env-token and registry-token', () => {
  it('falls through from the registry default to env-token when the token is unregistered', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'api-secret' }, serverTenant: 'default' },
      {
        deps: {
          env: { KYBERION_API_TOKEN: 'api-secret' },
          registrations: [
            { token_hash: hashToken('other-token'), role: 'readonly', tenant_slugs: ['default'] },
          ],
        },
      }
    );
    expect(resolution.decision.provider_id).toBe('registry-token');
    expect(resolution.principal.provider).toBe('env-token');
    expect(resolution.principal.role).toBe('readonly');
    expect(resolution.attempts[0]).toMatchObject({ provider: 'registry-token', outcome: 'not-mine' });
  });

  it('grants localadmin via KYBERION_LOCALADMIN_TOKEN', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'admin-secret' }, serverTenant: 'default' },
      { deps: { env: { KYBERION_LOCALADMIN_TOKEN: 'admin-secret' }, registrations: [] } }
    );
    expect(resolution.principal.role).toBe('localadmin');
  });

  it('denies an env-token remote request without a server tenant binding', () => {
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'api-secret' } },
          { deps: { env: { KYBERION_API_TOKEN: 'api-secret' }, registrations: [] } }
        ),
      403,
      'scope_denied'
    );
  });

  it('resolves a registered token to its member-bound scope', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'ignored' },
      {
        deps: {
          env: {},
          registrations: [
            {
              token_hash: hashToken('viewer-token'),
              role: 'readonly',
              tenant_slugs: ['default'],
              member_id: 'alice',
              label: 'alice viewer token',
            },
          ],
        },
      }
    );
    expect(resolution.principal.provider).toBe('registry-token');
    expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:alice' });
    expect(resolution.principal.memberId).toBe('alice');
    expect(resolution.principal.tenantSlugs).toEqual(['default']);
  });
});

// ---------------------------------------------------------------------------
// agent-context
// ---------------------------------------------------------------------------

describe('authn provider — agent-context', () => {
  it('resolves a registered agent identity from an actorHint', () => {
    const nhiId = seedActiveAgent('ctx-agent');
    const resolution = resolveAuthnPrincipal(
      {
        credential: { type: 'none' },
        serverTenant: 'default',
        executionContext: { actorHint: nhiId },
      },
      { deps: { env: {} } }
    );
    expect(resolution.principal.provider).toBe('agent-context');
    expect(resolution.principal.actor).toMatchObject({
      kind: 'agent',
      id: nhiId,
      on_behalf_of: 'user:founder',
    });
    expect(resolution.principal.role).toBe('readonly');
  });

  it('never authenticates a wire request from ambient process env', () => {
    // No executionContext attached (i.e. this is a remote request): ambient
    // KYBERION_PERSONA must not authenticate it.
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'none' }, serverTenant: 'default' },
          { deps: { env: { KYBERION_PERSONA: 'some-agent' } } }
        ),
      401
    );
  });

  it('denies a suspended identity in every NI-02 mode', () => {
    const nhiId = seedActiveAgent('ctx-suspended');
    withExecutionContext('mission_controller', () => suspendAgentIdentity(nhiId));
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          {
            credential: { type: 'none' },
            executionContext: { actorHint: nhiId },
          },
          { deps: { env: {} } }
        ),
      401
    );
  });

  it('rejects an unregistered agent under enforce mode', () => {
    vi.stubEnv('KYBERION_NHI_ACTOR', 'enforce');
    clearNhiActorVerificationCache();
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          {
            credential: { type: 'none' },
            executionContext: { actorHint: 'kyberion://agent/default/ghost' },
          },
          { deps: { env: {} } }
        ),
      401
    );
  });
});

// ---------------------------------------------------------------------------
// agent-token
// ---------------------------------------------------------------------------

describe('authn provider — agent-token', () => {
  const deps = { env: { KYBERION_AGENT_TOKEN_SECRET: AGENT_SECRET }, registrations: [] };

  function tokenFor(nhiId: string, extra: { ttlSeconds?: number; tenants?: string[] } = {}) {
    return issueAgentToken({ nhiId, ...extra }, deps).token;
  }

  it('issues and resolves a signed workload credential', () => {
    const nhiId = seedActiveAgent('token-agent');
    const token = tokenFor(nhiId, { tenants: ['default'] });
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'agent-token', token }, serverTenant: 'default' },
      { deps }
    );
    expect(resolution.principal.provider).toBe('agent-token');
    expect(resolution.principal.actor).toMatchObject({ kind: 'agent', id: nhiId });
    expect(resolution.principal.tenantSlugs).toEqual(['default']);
    expect(resolution.principal.assurance).toBe('high');
    expect(resolution.principal.expiresAt).toBeDefined();
  });

  it('rejects a tampered signature', () => {
    const nhiId = seedActiveAgent('token-agent-2');
    const token = `${tokenFor(nhiId)}x`;
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'agent-token', token } },
          { deps }
        ),
      401
    );
  });

  it('rejects an expired token', () => {
    const nhiId = seedActiveAgent('token-agent-3');
    const { token } = issueAgentToken({ nhiId, ttlSeconds: 1 }, deps);
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'agent-token', token } },
          { deps: { ...deps, now: Date.now() + 10_000 } }
        ),
      401
    );
  });

  it('rejects a suspended identity even with a valid signature', () => {
    const nhiId = seedActiveAgent('token-agent-4');
    const token = tokenFor(nhiId);
    withExecutionContext('mission_controller', () => suspendAgentIdentity(nhiId));
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'agent-token', token } },
          { deps }
        ),
      401
    );
  });

  it('refuses to mint a token for an unregistered identity', () => {
    expect(() =>
      issueAgentToken({ nhiId: 'kyberion://agent/default/unregistered' }, deps)
    ).toThrowError(AuthnError);
  });
});

// ---------------------------------------------------------------------------
// oidc-jwt
// ---------------------------------------------------------------------------

describe('authn provider — oidc-jwt', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1' };
  const jwks = { keys: [jwk] };

  function b64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  function jwt(payload: Record<string, unknown>, kid = 'k1'): string {
    const header = b64url({ alg: 'RS256', kid });
    const body = b64url(payload);
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString(
      'base64url'
    );
    return `${header}.${body}.${signature}`;
  }

  const deps = {
    env: { KYBERION_OIDC_ISSUER: 'https://issuer.example' },
    jwks,
    registrations: [] as never[],
  };

  const validClaims = {
    iss: 'https://issuer.example',
    sub: 'user:alice',
    exp: Math.floor(Date.now() / 1000) + 600,
    kyberion_tenants: ['default'],
  };

  it('verifies an RS256 JWT against configured JWKS and maps claims to scope', () => {
    const token = jwt({ ...validClaims, kyberion_role: 'localadmin' });
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'jwt', token } },
      { deps }
    );
    expect(resolution.principal.provider).toBe('oidc-jwt');
    expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:alice' });
    expect(resolution.principal.memberId).toBe('alice');
    expect(resolution.principal.role).toBe('localadmin');
    expect(resolution.principal.tenantSlugs).toEqual(['default']);
    expect(resolution.principal.assurance).toBe('high');
  });

  it('rejects an expired JWT', () => {
    const token = jwt({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 });
    expectAuthnRejection(
      () => resolveAuthnPrincipal({ credential: { type: 'jwt', token } }, { deps }),
      401
    );
  });

  it('rejects a bad signature', () => {
    const token = `${jwt(validClaims)}x`;
    expectAuthnRejection(
      () => resolveAuthnPrincipal({ credential: { type: 'jwt', token } }, { deps }),
      401
    );
  });

  it('fails closed on missing tenant claims without a server tenant', () => {
    const token = jwt({ iss: 'https://issuer.example', sub: 'ext-subject', exp: Math.floor(Date.now() / 1000) + 600 });
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'jwt', token } },
      { deps }
    );
    expect(resolution.principal.tenantSlugs).toEqual([]);
  });

  it('rejects a token whose kid matches no JWKS key', () => {
    const token = jwt(validClaims, 'unknown-kid');
    expectAuthnRejection(
      () => resolveAuthnPrincipal({ credential: { type: 'jwt', token } }, { deps }),
      401
    );
  });

  it('is ineligible when KYBERION_OIDC_ISSUER is not configured', () => {
    // Without an issuer binding the provider would claim every JWT-shaped
    // token — misconfiguration must mean ineligible, not permissive.
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'jwt', token: jwt(validClaims) } },
          { deps: { env: {}, jwks, registrations: [] } }
        ),
      401
    );
  });

  it('falls through (then fails closed) on an issuer mismatch', () => {
    const token = jwt({ ...validClaims, iss: 'https://other-issuer.example' });
    expectAuthnRejection(
      () => resolveAuthnPrincipal({ credential: { type: 'jwt', token } }, { deps }),
      401
    );
  });

  it('rejects an audience mismatch when KYBERION_OIDC_AUDIENCE is set', () => {
    const token = jwt({ ...validClaims, aud: 'someone-else' });
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'jwt', token } },
          { deps: { ...deps, env: { ...deps.env, KYBERION_OIDC_AUDIENCE: 'kyberion' } } }
        ),
      401
    );
  });

  it('refuses HS256 unless KYBERION_OIDC_ALLOW_HS256 is enabled', () => {
    const secret = Buffer.from('hs256-test-secret').toString('base64url');
    const octJwks = { keys: [{ kty: 'oct', k: secret, kid: 'hs1', use: 'sig', alg: 'HS256' }] };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'hs1' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(validClaims)).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(`${header}.${body}`)
      .digest('base64url');
    const hsToken = `${header}.${body}.${signature}`;

    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'jwt', token: hsToken } },
          { deps: { env: deps.env, jwks: octJwks, registrations: [] } }
        ),
      401
    );

    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'jwt', token: hsToken } },
      {
        deps: {
          env: { ...deps.env, KYBERION_OIDC_ALLOW_HS256: '1' },
          jwks: octJwks,
          registrations: [],
        },
      }
    );
    expect(resolution.principal.provider).toBe('oidc-jwt');
  });
});

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

describe('toSurfaceViewerScope', () => {
  it('projects principal claims losslessly onto the existing viewer scope', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'none' }, loopback: true, serverTenant: 'default' },
      { deps: { env: {} } }
    );
    const scope = toSurfaceViewerScope(resolution.principal);
    expect(scope).toMatchObject({
      role: 'localadmin',
      principalId: 'user:owner',
      tenantSlugs: ['default'],
      source: 'loopback',
    });
  });
});
