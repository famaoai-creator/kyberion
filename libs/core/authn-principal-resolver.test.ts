import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

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
        Object.entries(rule.when.context ?? {}).every(([k, v]) => request.context?.[k] === v)
    ) ?? null,
  getSeamTraitOverrides: (seam: string) => overlay.overrides[seam] ?? {},
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: (seam: string, key: string) => pins.get(`${seam}:${key}`) ?? null,
  pinSeamProviderDecision: (seam: string, key: string, providerId: string, purpose?: string) => {
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

const { AuthnError, listAuthnProviders, resolveAuthnPrincipal, toSurfaceViewerScope } =
  await import('./authn-principal-resolver.js');
const { AGENT_TOKEN_ISSUER, BUILTIN_AUTHN_PROVIDER_IDS, issueAgentToken } =
  await import('./authn-providers.js');
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

function expectAuthnRejection(fn: () => unknown, status: 401 | 403, code?: string): void {
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
    expect(
      listAuthnProviders()
        .map((p) => p.id)
        .sort()
    ).toEqual([...BUILTIN_AUTHN_PROVIDER_IDS].sort());
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
      {
        deps: {
          env: { KYBERION_API_TOKEN: 'api-secret' },
          registrations: [
            { token_hash: hashToken('api-secret'), role: 'localadmin', tenant_slugs: ['default'] },
          ],
        },
      }
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

  it('resolves a synthetic principal when explicitly configured under the test harness', () => {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'none' }, serverTenant: 'default' },
      { purpose: 'test', deps: { env: { ...STUB_ENV, VITEST: '1' } } }
    );
    expect(resolution.principal.provider).toBe('stub');
    expect(resolution.principal.principalId).toBe('stub:tester');
    expect(resolution.principal.assurance).toBe('none');
    expect(resolution.principal.actor.kind).toBe('service');
  });

  it('never authenticates a remote credential-free request outside the test harness', () => {
    // KYBERION_AUTHN_STUB_PRINCIPAL set in a served process must not grant a
    // synthetic identity to unauthenticated wire traffic (no fail-open).
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'none' }, serverTenant: 'default' },
          { purpose: 'test', deps: { env: STUB_ENV } }
        ),
      401
    );
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
    expect(resolution.attempts[0]).toMatchObject({
      provider: 'registry-token',
      outcome: 'not-mine',
    });
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
    const rootDir = writeRegistryTokenMember('alice', 'active');
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'ignored' },
      {
        deps: {
          env: {},
          memberRegistry: { rootDir },
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

  it('denies a token bound to a suspended member (F1)', () => {
    // Suspending the member does not revoke its chronos-access registration
    // — the provider itself must fail closed, or the token would fall
    // through to an "unregistered" principal and the credential's flat role
    // could *upgrade* the suspended member back to owner downstream.
    const rootDir = writeRegistryTokenMember('alice', 'suspended');
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'default' },
          {
            deps: {
              env: {},
              memberRegistry: { rootDir },
              registrations: [
                {
                  token_hash: hashToken('viewer-token'),
                  role: 'localadmin',
                  tenant_slugs: ['default'],
                  member_id: 'alice',
                  label: 'alice viewer token',
                },
              ],
            },
          }
        ),
      403,
      'scope_denied'
    );
  });

  it('denies a label-only token bound to a suspended member (F1-residual)', () => {
    // Legacy registrations without member_id still bind through the label —
    // a suspended member's label must fail closed at authentication, not
    // degrade to an unregistered localadmin on non-member-aware routes.
    const rootDir = writeRegistryTokenMember('alice', 'suspended', ['alice-token']);
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'default' },
          {
            deps: {
              env: {},
              memberRegistry: { rootDir },
              registrations: [
                {
                  token_hash: hashToken('viewer-token'),
                  role: 'localadmin',
                  tenant_slugs: ['default'],
                  label: 'alice-token',
                },
              ],
            },
          }
        ),
      403,
      'scope_denied'
    );
  });

  it('upgrades a label-only token bound to an active member to member identity', () => {
    const rootDir = writeRegistryTokenMember('alice', 'active', ['alice-token']);
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'default' },
      {
        deps: {
          env: {},
          memberRegistry: { rootDir },
          registrations: [
            {
              token_hash: hashToken('viewer-token'),
              role: 'localadmin',
              tenant_slugs: ['default'],
              label: 'alice-token',
            },
          ],
        },
      }
    );
    expect(resolution.principal.provider).toBe('registry-token');
    expect(resolution.principal.memberId).toBe('alice');
    expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:alice' });
    expect(resolution.principal.registrationLabel).toBe('alice-token');
  });

  it('keeps an unbound label-only token unregistered (legacy fallback)', () => {
    const rootDir = writeRegistryTokenMember('alice', 'active', ['alice-token']);
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'default' },
      {
        deps: {
          env: {},
          memberRegistry: { rootDir },
          registrations: [
            {
              token_hash: hashToken('viewer-token'),
              role: 'localadmin',
              tenant_slugs: ['default'],
              label: 'other-token',
            },
          ],
        },
      }
    );
    expect(resolution.principal.provider).toBe('registry-token');
    expect(resolution.principal.memberId).toBeUndefined();
  });

  it('denies a token bound to an unknown member (F1)', () => {
    const rootDir = writeRegistryTokenMember('alice', 'active');
    expectAuthnRejection(
      () =>
        resolveAuthnPrincipal(
          { credential: { type: 'bearer', token: 'viewer-token' }, serverTenant: 'default' },
          {
            deps: {
              env: {},
              memberRegistry: { rootDir },
              registrations: [
                {
                  token_hash: hashToken('viewer-token'),
                  role: 'localadmin',
                  tenant_slugs: ['default'],
                  member_id: 'ghost-member',
                  label: 'ghost token',
                },
              ],
            },
          }
        ),
      403,
      'scope_denied'
    );
  });
});

let memberFixtureCounter = 0;
function writeRegistryTokenMember(
  memberId: string,
  status: 'active' | 'suspended',
  registrationLabels: string[] = []
): string {
  const root = pathResolver.rootResolve(`${TMP_DIR}/registry-members-${++memberFixtureCounter}`);
  const dir = `${root}/knowledge/personal/members`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/${memberId}.json`,
    JSON.stringify(
      {
        member_id: memberId,
        display_name: memberId,
        status,
        memberships: [{ tenant_slug: 'default', role: 'owner' }],
        access_registrations: registrationLabels.map((label) => ({ label })),
        created_at: '2026-09-23T00:00:00.000Z',
        updated_at: '2026-09-23T00:00:00.000Z',
      },
      null,
      2
    )
  );
  return root;
}

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
      () => resolveAuthnPrincipal({ credential: { type: 'agent-token', token } }, { deps }),
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
      () => resolveAuthnPrincipal({ credential: { type: 'agent-token', token } }, { deps }),
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
    // `sub: user:alice` asserts a member binding — the member must exist and
    // be active in the local registry or the claim fails closed (403).
    const memberRoot = writeRegistryTokenMember('alice', 'active');
    const token = jwt({ ...validClaims, kyberion_role: 'localadmin' });
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'jwt', token } },
      { deps: { ...deps, memberRegistry: { rootDir: memberRoot } } }
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
    const token = jwt({
      iss: 'https://issuer.example',
      sub: 'ext-subject',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const resolution = resolveAuthnPrincipal({ credential: { type: 'jwt', token } }, { deps });
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

  describe('external identity → member mapping', () => {
    function writeMappedMember(member: Record<string, unknown>): string {
      const root = pathResolver.rootResolve(`${TMP_DIR}/members-${++counter}`);
      const dir = `${root}/knowledge/personal/members`;
      safeMkdir(dir, { recursive: true });
      safeWriteFile(`${dir}/${member.member_id}.json`, JSON.stringify(member, null, 2));
      return root;
    }

    function memberFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        member_id: 'carol',
        display_name: 'Carol',
        status: 'active',
        memberships: [
          { tenant_slug: 'acme-corp', role: 'approver' },
          { tenant_slug: 'default', role: 'viewer' },
        ],
        access_registrations: [],
        external_identities: [
          { issuer: 'https://issuer.example', subject: 'ext-subject', email: 'c@example.com' },
        ],
        created_at: '2026-09-23T00:00:00.000Z',
        updated_at: '2026-09-23T00:00:00.000Z',
        ...overrides,
      };
    }

    const externalClaims = {
      iss: 'https://issuer.example',
      sub: 'ext-subject',
      exp: Math.floor(Date.now() / 1000) + 600,
    };

    it('resolves a verified external identity to the bound member and its scope', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt(externalClaims);
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token } },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      expect(resolution.principal.memberId).toBe('carol');
      expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:carol' });
      // A viewer membership anywhere makes the flat role readonly — flat
      // consumers apply it scope-wide; per-tenant strength is member-aware
      // authz's job (member-membership provider).
      expect(resolution.principal.role).toBe('readonly');
      expect(resolution.principal.tenantSlugs).toEqual(['acme-corp', 'default']);
      expect(resolution.principal.provider).toBe('oidc-jwt');
    });

    it('projects localadmin only when every membership is localadmin-class', () => {
      const rootDir = writeMappedMember(
        memberFixture({
          memberships: [
            { tenant_slug: 'acme-corp', role: 'approver' },
            { tenant_slug: 'default', role: 'operator' },
          ],
        })
      );
      const token = jwt(externalClaims);
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token } },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      expect(resolution.principal.role).toBe('localadmin');
      expect(resolution.principal.tenantSlugs).toEqual(['acme-corp', 'default']);
    });

    it('narrows the membership scope to the server-bound tenant', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt(externalClaims);
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token }, serverTenant: 'default' },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      expect(resolution.principal.tenantSlugs).toEqual(['default']);
    });

    it('lets kyberion_tenants claims narrow (never widen) the membership scope', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt({ ...externalClaims, kyberion_tenants: ['acme-corp', 'other-tenant'] });
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token } },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      // 'other-tenant' is not a membership — it must be dropped, not granted.
      expect(resolution.principal.tenantSlugs).toEqual(['acme-corp']);
    });

    it('keeps an unmapped external subject unregistered and readonly', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt({ ...externalClaims, sub: 'someone-else' });
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token } },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      expect(resolution.principal.memberId).toBeUndefined();
      expect(resolution.principal.actor.id).toMatch(/^user:ext-/);
      expect(resolution.principal.role).toBe('readonly');
    });

    it('denies a suspended member outright — no unregistered fallback', () => {
      // The iss+sub IS bound — to a suspended member. Degrading to `ext-`
      // would let a `kyberion_role: localadmin` claim re-enter as an
      // unregistered localadmin; authentication itself must fail closed.
      const rootDir = writeMappedMember(memberFixture({ status: 'suspended' }));
      const token = jwt({ ...externalClaims, kyberion_role: 'localadmin' });
      expectAuthnRejection(
        () =>
          resolveAuthnPrincipal(
            { credential: { type: 'jwt', token } },
            { deps: { ...deps, memberRegistry: { rootDir } } }
          ),
        403
      );
    });

    it('a member_id claim cannot resurrect a member the registry knows as suspended', () => {
      // Custom-claim IdPs mint member_id directly; the local registry still
      // vetoes a suspended member — the claim is denied, never degraded to
      // an unregistered external identity.
      const rootDir = writeMappedMember(memberFixture({ status: 'suspended' }));
      const token = jwt({
        iss: 'https://issuer.example',
        sub: 'unrelated-subject',
        member_id: 'carol',
        kyberion_tenants: ['acme-corp'],
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      expectAuthnRejection(
        () =>
          resolveAuthnPrincipal(
            { credential: { type: 'jwt', token } },
            { deps: { ...deps, memberRegistry: { rootDir } } }
          ),
        403
      );
    });

    it('a member_id claim naming an unknown member is denied', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt({
        iss: 'https://issuer.example',
        sub: 'unrelated-subject',
        member_id: 'ghost',
        kyberion_tenants: ['acme-corp'],
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      expectAuthnRejection(
        () =>
          resolveAuthnPrincipal(
            { credential: { type: 'jwt', token } },
            { deps: { ...deps, memberRegistry: { rootDir } } }
          ),
        403
      );
    });

    it('an active member_id claim still binds the member from claims', () => {
      const rootDir = writeMappedMember(memberFixture());
      const token = jwt({
        iss: 'https://issuer.example',
        sub: 'unrelated-subject',
        member_id: 'carol',
        kyberion_tenants: ['acme-corp'],
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const resolution = resolveAuthnPrincipal(
        { credential: { type: 'jwt', token } },
        { deps: { ...deps, memberRegistry: { rootDir } } }
      );
      expect(resolution.principal.memberId).toBe('carol');
      expect(resolution.principal.actor).toMatchObject({ kind: 'human', id: 'user:carol' });
      // Claim-derived scope (the IdP is the authority on this path).
      expect(resolution.principal.tenantSlugs).toEqual(['acme-corp']);
    });
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

    const memberRoot = writeRegistryTokenMember('alice', 'active');
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'jwt', token: hsToken } },
      {
        deps: {
          env: { ...deps.env, KYBERION_OIDC_ALLOW_HS256: '1' },
          jwks: octJwks,
          registrations: [],
          memberRegistry: { rootDir: memberRoot },
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
