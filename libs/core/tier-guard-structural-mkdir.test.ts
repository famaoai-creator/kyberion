import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import * as paths from './path-resolver.js';
import { withExecutionContext, resetRoleAssumptionPolicyCache } from './authority.js';
import {
  runInResourceAccessScope,
  type ResourceAccessScope,
} from './foundation/resource-access-scope.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { executeSurfaceManagementMutation } from './surface/surface-management-mutations.js';

vi.mock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));
vi.mock('./foundation/lock-utils.js', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(),
  registerLockIo: vi.fn(),
}));

const REAL_ROOT = pathResolver.rootDir();
const TENANT = 'tenant-structural-test';
const ORG = 'org-structural-test';
const MEMBER = 'structural-owner-test';
const PREFIX = 'active/organizations/confidential';
const FILE = PREFIX + '/' + TENANT + '/' + ORG + '/state/organization-state.json';
const PROFILE = 'knowledge/personal/tenants/' + TENANT + '.json';
let fixture: string;
const at = (target: string) => path.join(fixture, target);
const directories = (file: string): string[] => {
  const result: string[] = [];
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir))
    result.push(dir);
  return result;
};
function capability(patch: Partial<ResourceAccessScope> = {}): ResourceAccessScope {
  return {
    tenantSlug: TENANT,
    organizationId: ORG,
    readExact: [FILE],
    writeExact: [FILE],
    mkdirExact: directories(FILE),
    allowProductKnowledgeRead: true,
    ...patch,
  };
}
function writer<T>(fn: () => T, patch: Partial<ResourceAccessScope> = {}): T {
  return runInResourceAccessScope(capability(patch), () =>
    withExecutionContext('concierge_management_writer', fn, undefined, TENANT, ORG)
  );
}
function profile(status: string): void {
  safeWriteFile(
    at(PROFILE),
    JSON.stringify({
      tenant_slug: TENANT,
      display_name: 'Structural fixture',
      status,
      assigned_role: 'customer',
    })
  );
}
beforeEach(() => {
  for (const key of [
    'SYSTEM_ROLE',
    'MISSION_ROLE',
    'KYBERION_PERSONA',
    'KYBERION_SUDO',
    'KYBERION_TENANT',
    'KYBERION_DELEGATED_ROLE',
    'KYBERION_TENANT_SCOPE_REQUIRED',
  ])
    vi.stubEnv(key, '');
  fixture = path.join(REAL_ROOT, 'active/shared/tmp/structural-mkdir-' + crypto.randomUUID());
  safeMkdir(path.dirname(at(PROFILE)));
  profile('active');
  safeWriteFile(
    at('knowledge/personal/members/' + MEMBER + '.json'),
    JSON.stringify({
      member_id: MEMBER,
      display_name: 'Owner',
      status: 'active',
      memberships: [{ tenant_slug: TENANT, role: 'owner' }],
      access_registrations: [],
      created_at: '2026-10-10T00:00:00Z',
      updated_at: '2026-10-10T00:00:00Z',
    })
  );
  // Product schemas are immutable real-checkout inputs. Data paths alone use
  // a fresh root, without creating any organization or project parent directory.
  const fixtureRoot = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const stack = new Error().stack || '';
    Error.stackTraceLimit = limit;
    return /\b(compileSchema|schemaCacheKey)\b/u.test(stack) ? REAL_ROOT : fixture;
  };
  vi.spyOn(pathResolver, 'rootDir').mockImplementation(fixtureRoot);
  vi.spyOn(paths, 'rootDir').mockImplementation(fixtureRoot);
  vi.spyOn(pathResolver, 'rootResolve').mockImplementation((value) => path.resolve(fixture, value));
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_TENANT', TENANT);
  vi.stubEnv('KYBERION_ENTITY_GOVERNANCE', 'enforce');
  resetRoleAssumptionPolicyCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRoleAssumptionPolicyCache();
  safeRmSync(fixture, { recursive: true, force: true });
});

describe('scoped creation of missing structural tenant parents', () => {
  it('runs actual organization and project creation from an empty data root without SUDO', async () => {
    expect(safeExistsSync(at('active/organizations'))).toBe(false);
    expect(safeExistsSync(at('active/projects'))).toBe(false);
    const auth = {
      actorId: 'user:' + MEMBER,
      memberId: MEMBER,
      tenantSlug: TENANT,
      allowedOrganizationIds: 'all' as const,
      allowedProjectIds: 'all' as const,
    };
    const organization = await executeSurfaceManagementMutation(auth, {
      operation: 'organization.create',
      requestId: 'structural-org-create',
      name: 'Fresh organization',
      purpose: 'Prove clean-checkout creation',
    });
    expect(organization.resource.kind).toBe('organization');
    const project = await executeSurfaceManagementMutation(auth, {
      operation: 'project.create',
      requestId: 'structural-project-create',
      organizationId: organization.organizationId,
      name: 'Fresh project',
      summary: 'Bounded',
    });
    expect(project.resource.kind).toBe('project');
    expect(safeExistsSync(at(PREFIX + '/' + TENANT))).toBe(true);
  });

  it('supports actual exact mkdir and file writes with a complete capability', () => {
    writer(() => {
      safeMkdir(at(path.posix.dirname(FILE)));
      safeWriteFile(at(FILE), 'fixture');
      expect(safeReadFile(at(FILE), { encoding: 'utf8' })).toBe('fixture');
    });
  });

  it('requires an active registered tenant regardless of ambient binding policy', () => {
    withExecutionContext('sovereign_concierge', () => profile('paused'));
    writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false));
    withExecutionContext('sovereign_concierge', () => safeRmSync(at(PROFILE), { force: true }));
    writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false));
  });

  it('rejects missing mkdir grants in either the inner or outer scope before creating anything', () => {
    const narrowed = capability({ mkdirExact: directories(FILE).filter((dir) => dir !== PREFIX) });
    runInResourceAccessScope(narrowed, () => {
      writer(() => expect(() => safeMkdir(at(path.posix.dirname(FILE)))).toThrow(/RESOURCE_SCOPE/));
    });
    writer(() => expect(() => safeMkdir(at(path.posix.dirname(FILE)))).toThrow(/RESOURCE_SCOPE/), {
      mkdirExact: narrowed.mkdirExact,
    });
    expect(safeExistsSync(at('active'))).toBe(false);
  });

  it('requires a same-tenant descendant write retained across all nested scopes', () => {
    writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false), {
      writeExact: [],
    });
    runInResourceAccessScope(capability({ writeExact: [] }), () => {
      writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false));
    });
    writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false), {
      writeExact: [PREFIX + '/other-tenant/org/state.json'],
    });
    writer(() => expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false), {
      writeExact: [PREFIX + '/' + TENANT + '-other/org/state.json'],
    });
  });

  it('does not exempt sibling or invalid tenant children even if explicitly listed', () => {
    for (const suffix of ['other-tenant', 'shared', 'INVALID_TENANT']) {
      const target = PREFIX + '/' + suffix;
      writer(() => expect(validateWritePermission(at(target), 'mkdir').allowed).toBe(false), {
        mkdirExact: [target],
        writeExact: [target + '/org/state.json'],
      });
    }
  });

  it('does not turn the structural root into a read, enumeration, delete, or file-write grant', () => {
    writer(
      () => {
        expect(validateReadPermission(at(PREFIX)).allowed).toBe(false);
        expect(validateWritePermission(at(PREFIX)).allowed).toBe(false);
        expect(() => safeReaddir(at(PREFIX))).toThrow();
        expect(() => safeRmSync(at(PREFIX), { recursive: true, force: true })).toThrow();
      },
      { readExact: [PREFIX, FILE], writeExact: [PREFIX, FILE] }
    );
  });

  it('continues ordinary policy checks after structural tenant classification', () => {
    const root = 'knowledge/confidential';
    writer(
      () => {
        expect(validateWritePermission(at(root), 'mkdir').allowed).toBe(false);
      },
      { mkdirExact: [root], writeExact: [root + '/' + TENANT + '/notes.json'] }
    );
  });

  it('does not broaden unscoped or other role authority', () => {
    withExecutionContext(
      'organization_operator',
      () => {
        expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false);
      },
      undefined,
      TENANT,
      ORG
    );
    runInResourceAccessScope(capability(), () => {
      withExecutionContext(
        'organization_operator',
        () => {
          expect(validateWritePermission(at(PREFIX), 'mkdir').allowed).toBe(false);
        },
        undefined,
        TENANT,
        ORG
      );
    });
    expect(() =>
      withExecutionContext('concierge_management_writer', () => null, undefined, TENANT, ORG)
    ).toThrow(/RESOURCE_SCOPE_REQUIRED/);
  });

  it('keeps malformed bindings and path escapes rejected', () => {
    for (const tenantSlug of ['shared', '../escape', '']) {
      expect(() => runInResourceAccessScope(capability({ tenantSlug }), () => null)).toThrow(
        /RESOURCE_SCOPE_INVALID/
      );
    }
    expect(() =>
      runInResourceAccessScope(capability({ mkdirExact: [PREFIX + '/../escape'] }), () => null)
    ).toThrow(/RESOURCE_SCOPE_INVALID/);
  });

  it('still rejects canonical redirection into another tenant', () => {
    const foreign = PREFIX + '/other-tenant';
    vi.stubEnv('KYBERION_SUDO', 'true');
    withExecutionContext('sovereign_concierge', () => {
      safeMkdir(at(foreign));
      safeSymlinkSync(at(foreign), at(PREFIX + '/' + TENANT));
    });
    vi.stubEnv('KYBERION_SUDO', 'false');
    writer(() => expect(() => safeMkdir(at(path.posix.dirname(FILE)))).toThrow(/RESOURCE_SCOPE/));
    expect(safeExistsSync(at(foreign + '/' + ORG))).toBe(false);
  });
});
