import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import type { AuthzQuery } from './authz-policy-engine.js';
import type { ResolvedPrincipal } from './authn-principal-resolver.js';

/**
 * Hermetic tests for the authz-policy-engine seam. Same discipline as
 * authn-principal-resolver.test.ts: the seam decision machinery is real
 * (governed policy JSONs), while operator rules / pins / audit are in-memory
 * doubles. Member-registry and policy-file inputs live in fixtures under
 * active/shared/tmp/ — the real tree is never touched.
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
  assertAuthorizedWithPolicyEngine,
  authorizeWithPolicyEngine,
  AuthzError,
  listAuthzProviders,
} = await import('./authz-policy-engine.js');
const { BUILTIN_AUTHZ_PROVIDER_IDS } = await import('./authz-providers.js');
const { humanActor, agentActor } = await import('./actor.js');

const TMP_DIR = `active/shared/tmp/authz-seam-tests-${process.pid}`;
let counter = 0;

function tmpRoot(): string {
  return pathResolver.rootResolve(`${TMP_DIR}/root-${counter}`);
}

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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => cleanupTmpDir());

function principal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    actor: humanActor('alice'),
    principalId: 'user:alice',
    role: 'localadmin',
    tenantSlugs: ['default'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential', 'personal'],
    source: 'token',
    provider: 'env-token',
    assurance: 'high',
    memberId: 'alice',
    ...overrides,
  };
}

function writePolicy(rules: unknown[]): string {
  const root = tmpRoot();
  const dir = `${root}/policy`;
  safeMkdir(dir, { recursive: true });
  const file = `${dir}/authz-policy.json`;
  safeWriteFile(file, JSON.stringify({ version: '1.0.0', rules }, null, 2));
  return file;
}

function writeMember(member: Record<string, unknown>): string {
  const root = tmpRoot();
  const dir = `${root}/knowledge/personal/members`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(`${dir}/${member.member_id}.json`, JSON.stringify(member, null, 2));
  return root;
}

// ---------------------------------------------------------------------------
// registry / selection
// ---------------------------------------------------------------------------

describe('authz seam — registry and selection', () => {
  it('registers all five built-in providers', () => {
    expect(listAuthzProviders().map((p) => p.id).sort()).toEqual(
      [...BUILTIN_AUTHZ_PROVIDER_IDS].sort()
    );
  });

  it('fails closed (deny) when no provider is eligible', () => {
    const query: AuthzQuery = {
      principal: principal({ actor: agentActor('kyberion://agent/default/bot') }),
      operation: { operationId: 'op.decide', effect: 'decide' },
    };
    // agent principal + decide effect: role-scope ineligible, member-membership
    // ineligible (not human), policy-file ineligible (no file) → allow-all /
    // deny-all eligible; the default-surface fallback ranks deny-all.
    const resolution = authorizeWithPolicyEngine(query, { deps: { env: {} } });
    expect(resolution.authorization.allowed).toBe(false);
    expect(resolution.authorization.provider).toBe('deny-all');
  });
});

// ---------------------------------------------------------------------------
// role-scope
// ---------------------------------------------------------------------------

describe('authz provider — role-scope', () => {
  const op = { operationId: 'surface.read', effect: 'read' as const };

  it('allows a localadmin read inside the tenant scope', () => {
    const resolution = authorizeWithPolicyEngine(
      { principal: principal(), operation: op, resource: { tenantSlug: 'default' } },
      { deps: { env: {} } }
    );
    expect(resolution.decision.provider_id).toBe('role-scope');
    expect(resolution.authorization).toMatchObject({ allowed: true, reasonCode: 'allowed' });
  });

  it('denies a readonly principal a write operation', () => {
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal({ role: 'readonly' }),
        operation: { operationId: 'surface.write', effect: 'write' },
        resource: { tenantSlug: 'default' },
      },
      { deps: { env: {} } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'permission_denied',
    });
  });

  it('denies a resource outside the principal tenant scope', () => {
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: op,
        resource: { tenantSlug: 'other-tenant' },
      },
      { deps: { env: {} } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'tenant_scope_denied',
    });
  });

  it('denies a resource on a tier the principal cannot see', () => {
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal({ tierAccess: ['public'] }),
        operation: op,
        resource: { tenantSlug: 'default', tier: 'confidential' },
      },
      { deps: { env: {} } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'tier_scope_denied',
    });
  });
});

// ---------------------------------------------------------------------------
// member-membership
// ---------------------------------------------------------------------------

describe('authz provider — member-membership', () => {
  function memberFixture(role: string, tenants = ['default'], status = 'active') {
    return writeMember({
      member_id: 'alice',
      display_name: 'Alice',
      status,
      memberships: tenants.map((tenant_slug) => ({ tenant_slug, role })),
      access_registrations: [],
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    });
  }

  it('grants the decide effect to an approver member', () => {
    const root = memberFixture('approver');
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'front-desk.approve', effect: 'decide' },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: true,
      provider: 'member-membership',
    });
  });

  it('denies the decide effect to a viewer member', () => {
    const root = memberFixture('viewer');
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'front-desk.approve', effect: 'decide' },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'permission_denied',
    });
  });

  it('denies a member with no membership in the resource tenant', () => {
    const root = memberFixture('viewer', ['other-tenant']);
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'surface.read', effect: 'read' },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'tenant_scope_denied',
    });
  });

  it('denies a suspended member', () => {
    const root = memberFixture('owner', ['default'], 'suspended');
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'surface.read', effect: 'read' },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'member_inactive',
    });
  });

  it('denies an operation that omits the canonical permission for its effect', () => {
    // Regression: a caller-supplied requiredPermissions list must not be able
    // to downgrade a 'decide' operation to a read-level permission.
    const root = memberFixture('owner');
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: {
          operationId: 'front-desk.approve',
          effect: 'decide',
          requiredPermissions: ['surface.headless.read'],
        },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'policy_missing',
    });
  });

  it('denies a human principal with no member record', () => {
    const root = tmpRoot();
    safeMkdir(`${root}/knowledge/personal/members`, { recursive: true });
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'front-desk.approve', effect: 'decide' },
        resource: { tenantSlug: 'default' },
      },
      { purpose: 'membership', deps: { env: {}, memberRegistry: { rootDir: root } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'member_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// policy-file
// ---------------------------------------------------------------------------

describe('authz provider — policy-file', () => {
  it('allows when an allow rule matches', () => {
    const file = writePolicy([
      { rule_id: 'r1', decision: 'allow', principals: ['user:*'], effects: ['read'] },
    ]);
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'any.op', effect: 'read' },
      },
      { purpose: 'governed', deps: { env: {}, policyPath: file } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: true,
      provider: 'policy-file',
      reasonCode: 'allowed',
      policyId: 'policy:r1',
    });
  });

  it('lets a deny rule win over an allow rule', () => {
    const file = writePolicy([
      { rule_id: 'allow-all', decision: 'allow', principals: ['*'] },
      { rule_id: 'deny-write', decision: 'deny', effects: ['write'] },
    ]);
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'any.op', effect: 'write' },
      },
      { purpose: 'governed', deps: { env: {}, policyPath: file } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'policy_rule_denied',
      policyId: 'policy:deny-write',
    });
  });

  it('denies when no rule matches', () => {
    const file = writePolicy([
      { rule_id: 'r1', decision: 'allow', operations: ['other.*'] },
    ]);
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal(),
        operation: { operationId: 'any.op', effect: 'read' },
      },
      { purpose: 'governed', deps: { env: {}, policyPath: file } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      reasonCode: 'no_matching_rule',
    });
  });

  it('is ineligible when the policy file is invalid', () => {
    const root = tmpRoot();
    safeMkdir(`${root}/policy`, { recursive: true });
    const file = `${root}/policy/bad.json`;
    safeWriteFile(file, JSON.stringify({ version: '9.9.9', rules: 'nope' }));
    const resolution = authorizeWithPolicyEngine(
      { principal: principal(), operation: { operationId: 'any.op', effect: 'read' } },
      { deps: { env: {}, policyPath: file } }
    );
    // policy-file out; role-scope handles the read instead.
    expect(resolution.authorization.provider).toBe('role-scope');
    expect(resolution.authorization.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allow-all / deny-all
// ---------------------------------------------------------------------------

describe('authz providers — allow-all / deny-all', () => {
  it('purpose "test" selects allow-all under the Vitest harness', () => {
    const resolution = authorizeWithPolicyEngine(
      { principal: principal({ role: 'readonly' }), operation: { operationId: 'x', effect: 'write' } },
      { purpose: 'test', deps: { env: { VITEST: '1' } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: true,
      provider: 'allow-all',
    });
  });

  it('purpose "lockdown" selects deny-all', () => {
    const resolution = authorizeWithPolicyEngine(
      { principal: principal(), operation: { operationId: 'x', effect: 'read' } },
      { purpose: 'lockdown', deps: { env: {} } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      provider: 'deny-all',
    });
  });

  it('allow-all is ineligible outside the Vitest runtime (no fail-open tie)', () => {
    // Regression: with purpose 'membership', a non-human principal and a
    // 'decide' op leave only allow-all/deny-all eligible — a zero-score
    // alphabetical tie used to pick allow-all. Outside Vitest allow-all must
    // never be eligible, so deny-all (fail closed) wins.
    const resolution = authorizeWithPolicyEngine(
      {
        principal: principal({ actor: agentActor('kyberion://agent/default/bot') }),
        operation: { operationId: 'op.decide', effect: 'decide' },
      },
      { purpose: 'membership', deps: { env: { VITEST: '' } } }
    );
    expect(resolution.authorization).toMatchObject({
      allowed: false,
      provider: 'deny-all',
    });
  });
});

// ---------------------------------------------------------------------------
// assertAuthorizedWithPolicyEngine
// ---------------------------------------------------------------------------

describe('assertAuthorizedWithPolicyEngine', () => {
  it('throws AuthzError carrying the deny decision', () => {
    expect(() =>
      assertAuthorizedWithPolicyEngine(
        {
          principal: principal({ role: 'readonly' }),
          operation: { operationId: 'surface.write', effect: 'write' },
          resource: { tenantSlug: 'default' },
        },
        { deps: { env: {} } }
      )
    ).toThrowError(AuthzError);
  });
});
