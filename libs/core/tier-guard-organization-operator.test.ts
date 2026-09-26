import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { buildOrganizationOperationRecord } from './organization-operating-model-management.js';
import {
  buildOrganizationScaffold,
  saveOrganizationOperation,
} from './organization-operating-model-operations.js';
import { saveOrganizationOperationalState } from './organization-operating-model-persistence.js';
import { recordOrganizationOperationRun } from './organization-operation-run-recording.js';
// Install the full identity resolver (MISSION_ROLE / tenant resolution) the
// production write path uses, instead of the bootstrap fallback.
import './authority.js';

// The tier guard emits best-effort audit events on denial; keep them off the
// real audit chain so the suite stays hermetic.
vi.mock('./audit-chain.js', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

function orgPath(tier: string, tenant: string): string {
  return path.join(ROOT, `active/organizations/${tier}/${tenant}/acme-ops/state/purpose.json`);
}

describe('tier-guard organization_operator authority role (R8)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function operator(tenant?: string, persona?: string): void {
    process.env.MISSION_ROLE = 'organization_operator';
    if (tenant) process.env.KYBERION_TENANT = tenant;
    if (persona) process.env.KYBERION_PERSONA = persona;
  }

  it('allows writing and reading its own tenant organization state', () => {
    operator('acme-corp');
    expect(validateWritePermission(orgPath('confidential', 'acme-corp'))).toEqual({
      allowed: true,
    });
    expect(validateWritePermission(orgPath('public', 'acme-corp'))).toEqual({ allowed: true });
    expect(validateReadPermission(orgPath('confidential', 'acme-corp'))).toEqual({
      allowed: true,
    });
  });

  it('keeps least privilege under the worker persona as well', () => {
    operator('acme-corp', 'worker');
    expect(validateWritePermission(orgPath('confidential', 'acme-corp')).allowed).toBe(true);
    expect(validateWritePermission(path.join(ROOT, 'knowledge/product/x.md')).allowed).toBe(false);
  });

  it("denies another tenant's organization state (write and read)", () => {
    operator('acme-corp');
    const write = validateWritePermission(orgPath('confidential', 'other-tenant'));
    expect(write.allowed).toBe(false);
    expect(write.reason).toMatch(/tenant\.scope_violation/);
    // `public` is not a tenant-scope protected prefix, so the role grant itself
    // must be what keeps the operator inside its own tenant.
    const publicWrite = validateWritePermission(orgPath('public', 'other-tenant'));
    expect(publicWrite.allowed).toBe(false);
    expect(publicWrite.reason).toMatch(/NOT authorized to write/);
    expect(validateReadPermission(orgPath('confidential', 'other-tenant')).allowed).toBe(false);
  });

  it('grants nothing tenant-scoped when no valid tenant is bound', () => {
    operator();
    expect(validateWritePermission(orgPath('confidential', 'acme-corp')).allowed).toBe(false);
    expect(validateWritePermission(orgPath('public', 'acme-corp')).allowed).toBe(false);
    // Reserved scope names never act as a tenant binding.
    process.env.KYBERION_TENANT = 'shared';
    expect(validateWritePermission(orgPath('confidential', 'shared')).allowed).toBe(false);
  });

  it('denies personal-tier organization state, knowledge/, .git and mission state', () => {
    operator('acme-corp');
    for (const target of [
      orgPath('personal', 'acme-corp'),
      'knowledge/confidential/acme-corp/notes.md',
      'knowledge/product/governance/security-policy.json',
      '.git/config',
      'active/missions/confidential/acme-corp/MSN-OTHER/mission-state.json',
    ]) {
      const result = validateWritePermission(path.resolve(ROOT, target));
      expect(result.allowed, target).toBe(false);
    }
  });

  it('leaves the sovereign persona unchanged', () => {
    process.env.KYBERION_PERSONA = 'sovereign';
    expect(validateWritePermission(orgPath('confidential', 'acme-corp')).allowed).toBe(true);
    expect(validateWritePermission(orgPath('confidential', 'other-tenant')).allowed).toBe(true);
    expect(validateWritePermission(path.join(ROOT, 'knowledge/product/x.md')).allowed).toBe(true);
  });

  it('still denies an unknown role for organization state', () => {
    process.env.MISSION_ROLE = 'organization_operator_typo';
    process.env.KYBERION_TENANT = 'acme-corp';
    const result = validateWritePermission(orgPath('confidential', 'acme-corp'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/NOT authorized to write/);
  });
});

/**
 * Point the repository root at `fixtureRoot`, except while a product JSON
 * schema is being compiled: those still live in the real repository (their
 * absolute paths are fixed at import), and outside a stand-in root the tier
 * guard would refuse them as "outside project root".
 */
function rootAtFixtureExceptSchemas(fixtureRoot: string): void {
  const realRoot = pathResolver.pathResolver.rootDir();
  vi.spyOn(pathResolver.pathResolver, 'rootDir').mockImplementation(() => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const stack = new Error().stack || '';
    Error.stackTraceLimit = limit;
    return /\b(compileSchema|schemaCacheKey)\b/u.test(stack) ? realRoot : fixtureRoot;
  });
}

describe('organization_operator on the real organization write path (R8)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const TENANT = 'acme-corp';
  const RUNBOOK = `knowledge/confidential/${TENANT}/operations/monthly-close.md`;
  let fixtureRoot: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Seed the fixture (tenant profile + runbook) while the fixture is still
    // an ordinary active/shared/tmp path, before it stands in for the repo root.
    fixtureRoot = pathResolver.pathResolver.sharedTmp(
      `org-operator-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const profileDir = path.join(fixtureRoot, 'knowledge/personal/tenants');
    safeMkdir(profileDir, { recursive: true });
    safeWriteFile(
      path.join(profileDir, `${TENANT}.json`),
      JSON.stringify({
        tenant_slug: TENANT,
        display_name: 'Acme Corp',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    safeMkdir(path.join(fixtureRoot, path.dirname(RUNBOOK)), { recursive: true });
    safeWriteFile(path.join(fixtureRoot, RUNBOOK), '# Monthly close\n');
    const groupDir = path.join(fixtureRoot, 'knowledge/confidential/tenant-groups');
    safeMkdir(groupDir, { recursive: true });
    for (const [groupId, members] of [
      ['acme-group', [TENANT, 'beta-corp']],
      ['other-group', ['beta-corp', 'gamma-corp']],
    ] as const) {
      safeWriteFile(
        path.join(groupDir, `${groupId}.json`),
        JSON.stringify({
          tenant_group_id: groupId,
          display_name: groupId,
          status: 'active',
          member_tenants: members,
          shared_prefixes: [`knowledge/confidential/shared/${groupId}/`],
        })
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('builds and saves tenant organization records with production tenant resolution', () => {
    const scope = { tier: 'confidential' as const, tenantSlug: TENANT, rootDir: fixtureRoot };
    const buildScaffold = () =>
      buildOrganizationScaffold({ organizationId: 'acme-ops', name: 'Acme Operations', ...scope });
    const buildOperation = () =>
      buildOrganizationOperationRecord({
        organizationId: 'acme-ops',
        operationId: 'monthly-close',
        name: 'Monthly close',
        operationType: 'scheduled',
        ownerRole: 'organization_owner',
        triggerKind: 'schedule',
        triggerExpression: '0 9 1 * *',
        triggerTimezone: 'Asia/Tokyo',
        executionKind: 'runbook',
        executionRef: RUNBOOK,
        ...scope,
      });
    // The fixture acts as the repository root for the tier guard, so the
    // tenant profile is judged as knowledge/personal/tenants/<slug>.json and
    // the runbook as knowledge/confidential/<slug>/… — exactly as in production.
    rootAtFixtureExceptSchemas(fixtureRoot);
    process.env.KYBERION_ENTITY_GOVERNANCE = 'enforce';
    process.env.MISSION_ROLE = 'organization_operator';
    process.env.KYBERION_TENANT = TENANT;
    // KYBERION_ENTITY_GOVERNANCE=enforce leaves the vitest bypass, so
    // assertRecordIdentity resolves the tenant profile as it does in production.

    const scaffold = buildScaffold();
    saveOrganizationOperationalState(scaffold.state, { rootDir: fixtureRoot });
    const operation = buildOperation();
    const operationPath = saveOrganizationOperation(operation, { rootDir: fixtureRoot });
    expect(operationPath).toContain(`active/organizations/confidential/${TENANT}/acme-ops/`);

    const recorded = recordOrganizationOperationRun({
      organizationId: 'acme-ops',
      operationId: 'monthly-close',
      runId: 'monthly-close-20260901',
      runStatus: 'succeeded',
      resultSummary: 'Closed',
      evidenceRefs: [RUNBOOK],
      completedAt: '2026-09-01T03:00:00.000Z',
      startedAt: '2026-09-01T02:00:00.000Z',
      apply: true,
      ...scope,
    });
    expect(recorded.saved_paths).toHaveLength(2);
    expect(validateReadPermission(path.join(fixtureRoot, RUNBOOK))).toEqual({ allowed: true });
  });

  it('reads tenant-group shares only for groups the tenant belongs to, and never common/', () => {
    rootAtFixtureExceptSchemas(fixtureRoot);
    // Tenant-group profiles resolve through pathResolver.knowledge; point only
    // those lookups at the fixture so the membership check reads its groups.
    const realKnowledge = pathResolver.pathResolver.knowledge.bind(pathResolver.pathResolver);
    vi.spyOn(pathResolver.pathResolver, 'knowledge').mockImplementation((subPath = '') =>
      String(subPath).startsWith('confidential/tenant-groups/')
        ? path.join(fixtureRoot, 'knowledge', String(subPath))
        : realKnowledge(subPath)
    );
    process.env.MISSION_ROLE = 'organization_operator';
    process.env.KYBERION_TENANT = TENANT;
    expect(
      validateReadPermission(
        path.join(fixtureRoot, 'knowledge/confidential/shared/acme-group/operations/sop.md')
      ).allowed
    ).toBe(true);
    expect(
      validateReadPermission(
        path.join(fixtureRoot, 'knowledge/confidential/shared/other-group/operations/sop.md')
      ).allowed
    ).toBe(false);
    expect(
      validateReadPermission(
        path.join(fixtureRoot, 'knowledge/confidential/common/operations/sop.md')
      ).allowed
    ).toBe(false);
    expect(
      validateWritePermission(
        path.join(fixtureRoot, 'knowledge/confidential/shared/acme-group/operations/sop.md')
      ).allowed
    ).toBe(false);
  });

  it('keeps other tenants and other personal files out of reach', () => {
    rootAtFixtureExceptSchemas(fixtureRoot);
    process.env.MISSION_ROLE = 'organization_operator';
    process.env.KYBERION_TENANT = TENANT;
    for (const target of [
      'knowledge/personal/tenants/other-tenant.json',
      `knowledge/personal/tenants/${TENANT}.json.bak`,
      'knowledge/personal/identity.json',
      'knowledge/confidential/other-tenant/operations/x.md',
    ]) {
      expect(validateReadPermission(path.join(fixtureRoot, target)).allowed, target).toBe(false);
    }
    expect(
      validateWritePermission(path.join(fixtureRoot, 'knowledge/confidential/common/x.md')).allowed
    ).toBe(false);
    expect(
      validateWritePermission(path.join(fixtureRoot, `knowledge/personal/tenants/${TENANT}.json`))
        .allowed
    ).toBe(false);
  });
});
