import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentResourceAccessScope,
  runInResourceAccessScope,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import {
  withExecutionContext,
  withExecutionContextAsync,
  resetRoleAssumptionPolicyCache,
} from '../authority.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import {
  safeExistsSync,
  safeRealpath,
  safeCreateExclusiveFileSync,
  safeOpenAppendFile,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeMoveSync,
  safeRmSync,
  safeStat,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));
vi.mock('../governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));

const ROOT = pathResolver.rootDir();
const ENV = [
  'SYSTEM_ROLE',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'KYBERION_SUDO',
  'KYBERION_TENANT',
  'KYBERION_PROJECT_ID',
  'MISSION_ID',
  'KYBERION_DELEGATED_ROLE',
] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let exact: string;
let foreign: string;
function scope(overrides: Partial<ResourceAccessScope> = {}): ResourceAccessScope {
  return {
    tenantSlug: 'acme-corp',
    organizationId: 'org-a',
    projectId: 'project-a',
    readExact: [exact],
    writeExact: [exact],
    mkdirExact: [base, base + '/nested'],
    allowProductKnowledgeRead: true,
    ...overrides,
  };
}
const abs = (target: string) => path.resolve(ROOT, target);

beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetRoleAssumptionPolicyCache();
  base = 'active/shared/tmp/resource-scope-' + crypto.randomUUID();
  exact = base + '/nested/allowed.json';
  foreign = base + '/foreign.json';
  safeMkdir(abs(base));
  safeWriteFile(abs(foreign), 'foreign');
});
afterEach(() => {
  for (const key of ENV) delete process.env[key];
  resetRoleAssumptionPolicyCache();
  safeRmSync(abs(base), { recursive: true, force: true });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetRoleAssumptionPolicyCache();
});

describe('request resource ceiling', () => {
  it('grants metadata-only paths without contents, listing, mutation, or scope widening', () => {
    runInResourceAccessScope(scope({ metadataExact: [foreign] }), () => {
      expect(safeExistsSync(abs(foreign))).toBe(true);
      expect(safeStat(abs(foreign)).isFile()).toBe(true);
      expect(() => safeReadFile(abs(foreign))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeReaddir(abs(foreign))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeMkdir(abs(foreign))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeWriteFile(abs(foreign), 'blocked')).toThrow(/RESOURCE_SCOPE/);
      runInResourceAccessScope(scope({ metadataExact: [] }), () => {
        expect(() => safeExistsSync(abs(foreign))).toThrow(/RESOURCE_SCOPE/);
      });
    });
    expect(() =>
      runInResourceAccessScope(scope({ metadataExact: ['../bad'] }), () => null)
    ).toThrow(/RESOURCE_SCOPE_INVALID/);
  });

  it('bounds existence and realpath metadata, including canonical symlink targets', () => {
    safeMkdir(abs(base + '/nested'));
    safeSymlinkSync(abs(foreign), abs(exact));
    runInResourceAccessScope(scope(), () => {
      expect(safeExistsSync(abs(base))).toBe(true);
      expect(safeRealpath(abs(base))).toContain(base);
      for (const target of [
        foreign,
        'knowledge/personal/members/foreign.json',
        'active/shared/runtime/projects/FOREIGN.json',
      ]) {
        expect(() => safeExistsSync(abs(target))).toThrow(/RESOURCE_SCOPE/);
        expect(() => safeRealpath(abs(target))).toThrow(/RESOURCE_SCOPE/);
      }
      expect(() => safeExistsSync(abs(exact))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeRealpath(abs(exact))).toThrow(/RESOURCE_SCOPE/);
    });
    // Preserve the established unscoped metadata behavior.
    expect(safeExistsSync(abs(foreign))).toBe(true);
    expect(safeRealpath(abs(exact))).toContain(foreign);
  });

  it('never creates implicit parent directories from a file-write capability', () => {
    for (const write of [
      () => safeWriteFile(abs(exact), 'blocked'),
      () => safeCreateExclusiveFileSync(abs(exact), 'blocked'),
      () => safeOpenAppendFile(abs(exact)),
    ]) {
      runInResourceAccessScope(scope({ mkdirExact: [] }), () => {
        expect(write).toThrow(/RESOURCE_SCOPE/);
      });
      expect(safeExistsSync(abs(base + '/nested'))).toBe(false);
    }
  });

  it('preflights the complete mkdir chain before creating omitted ancestors', () => {
    const leaf = base + '/first/second';
    runInResourceAccessScope(scope({ mkdirExact: [leaf] }), () => {
      expect(() => safeMkdir(abs(leaf))).toThrow(/RESOURCE_SCOPE/);
    });
    expect(safeExistsSync(abs(base + '/first'))).toBe(false);
    runInResourceAccessScope(scope({ mkdirExact: [base + '/first', leaf] }), () => {
      safeMkdir(abs(leaf));
      expect(safeExistsSync(abs(leaf))).toBe(true);
    });
  });

  it('permits exact governed I/O and directory creation, never ancestor removal or rename', () => {
    runInResourceAccessScope(scope(), () => {
      safeMkdir(abs(base + '/nested'));
      safeWriteFile(abs(exact), 'allowed');
      expect(safeReadFile(abs(exact), { encoding: 'utf8' })).toBe('allowed');
      expect(safeStat(abs(base)).isDirectory()).toBe(true);
      expect(safeLstat(abs(base)).isDirectory()).toBe(true);
      expect(() => safeReaddir(abs(base))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeRmSync(abs(base), { recursive: true, force: true })).toThrow(
        /RESOURCE_SCOPE/
      );
      expect(() => safeMoveSync(abs(base), abs(base + '-moved'))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeMkdir(abs(base + '/sibling'))).toThrow(/RESOURCE_SCOPE/);
    });
  });

  it('denies default_allow runtime, foreign tenant, project, organization, and personal reads', () => {
    runInResourceAccessScope(scope(), () => {
      for (const target of [
        foreign,
        'active/shared/runtime/foreign.json',
        'active/shared/runtime/projects/foreign.json',
        'active/organizations/confidential/acme-corp/other/state/purpose.json',
        'active/projects/confidential/other-tenant/project-a/state/project-state.json',
        'knowledge/personal/members/foreign.json',
      ]) {
        expect(validateReadPermission(abs(target)).allowed, target).toBe(false);
        expect(validateWritePermission(abs(target)).allowed, target).toBe(false);
      }
    });
  });

  it('is enforced before SUDO, sovereign persona, and nested broad role assumptions', () => {
    process.env.KYBERION_SUDO = 'true';
    process.env.KYBERION_PERSONA = 'sovereign';
    runInResourceAccessScope(scope(), () =>
      withExecutionContext('ecosystem_architect', () => {
        expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
        expect(validateReadPermission(abs(foreign)).allowed).toBe(false);
        expect(() => safeReadFile(abs(foreign))).toThrow(/RESOURCE_SCOPE/);
      })
    );
  });

  it('intersects nested scopes instead of replacing outer restrictions', () => {
    runInResourceAccessScope(scope(), () => {
      runInResourceAccessScope(scope({ readExact: [foreign], writeExact: [foreign] }), () => {
        expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
        expect(validateWritePermission(abs(exact)).allowed).toBe(false);
      });
      expect(validateWritePermission(abs(exact)).allowed).toBe(true);
    });
    expect(currentResourceAccessScope()).toBeUndefined();
  });

  it('freezes caller-owned arrays before use', () => {
    const allowed = [exact];
    runInResourceAccessScope(scope({ writeExact: allowed }), () => {
      allowed.push(foreign);
      expect(Object.isFrozen(currentResourceAccessScope()?.writeExact)).toBe(true);
      expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
    });
  });

  it('keeps concurrent tenant capabilities isolated across awaits', async () => {
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const a = runInResourceAccessScope(scope(), () =>
      withExecutionContextAsync(
        'organization_operator',
        async () => {
          await wait;
          expect(currentResourceAccessScope()?.tenantSlug).toBe('acme-corp');
          expect(validateWritePermission(abs(exact)).allowed).toBe(true);
          expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
        },
        undefined,
        'acme-corp',
        'org-a'
      )
    );
    const b = runInResourceAccessScope(
      scope({
        tenantSlug: 'other-tenant',
        organizationId: 'org-b',
        projectId: 'project-b',
        readExact: [foreign],
        writeExact: [foreign],
      }),
      () =>
        withExecutionContextAsync(
          'organization_operator',
          async () => {
            await Promise.resolve();
            expect(currentResourceAccessScope()?.tenantSlug).toBe('other-tenant');
            expect(validateWritePermission(abs(foreign)).allowed).toBe(true);
            expect(validateWritePermission(abs(exact)).allowed).toBe(false);
            unblock();
          },
          undefined,
          'other-tenant',
          'org-b'
        )
    );
    await Promise.all([a, b]);
  });

  it('rejects invalid bindings, malformed paths and scope rebinding', () => {
    for (const patch of [
      { tenantSlug: 'shared' },
      { tenantSlug: '' },
      { organizationId: '../bad' },
      { projectId: '../bad' },
      { readExact: ['/etc/passwd'] },
      { writeExact: ['active/../other'] },
      { mkdirExact: ['active/'] },
      { readExact: ['active/**'] },
    ])
      expect(() => runInResourceAccessScope(scope(patch), () => null)).toThrow(
        /RESOURCE_SCOPE_INVALID/
      );
    runInResourceAccessScope(scope(), () => {
      expect(() =>
        runInResourceAccessScope(scope({ tenantSlug: 'other-tenant' }), () => null)
      ).toThrow(/RESOURCE_SCOPE_INVALID/);
    });
  });

  it('allows product catalogs only as explicit read-only option', () => {
    const catalog = abs('knowledge/product/governance/security-policy.json');
    runInResourceAccessScope(scope(), () => {
      expect(validateReadPermission(catalog).allowed).toBe(true);
      expect(validateWritePermission(catalog).allowed).toBe(false);
    });
    runInResourceAccessScope(scope({ allowProductKnowledgeRead: false }), () => {
      expect(validateReadPermission(catalog).allowed).toBe(false);
    });
  });

  it('checks the physical path, so a permitted alias cannot read or write a foreign target', () => {
    safeMkdir(abs(base + '/nested'));
    safeSymlinkSync(abs(foreign), abs(exact));
    runInResourceAccessScope(scope(), () => {
      expect(() => safeReadFile(abs(exact))).toThrow(/RESOURCE_SCOPE/);
      expect(() => safeWriteFile(abs(exact), 'wrong')).toThrow(/RESOURCE_SCOPE/);
    });
    expect(safeReadFile(abs(foreign), { encoding: 'utf8' })).toBe('foreign');
  });
});

describe('management authority requires a resource capability', () => {
  it('denies management writer with no binding even on default_allow paths', () => {
    process.env.SYSTEM_ROLE = 'concierge';
    expect(() => withExecutionContext('concierge_management_writer', () => null)).toThrow(
      /RESOURCE_SCOPE_REQUIRED/
    );
    delete process.env.SYSTEM_ROLE;
    process.env.MISSION_ROLE = 'concierge_management_writer';
    expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
    expect(validateReadPermission(abs(foreign)).allowed).toBe(false);
  });

  it('allows only Concierge to assume the new roles', () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    runInResourceAccessScope(scope(), () => {
      expect(() =>
        withExecutionContext(
          'concierge_management_writer',
          () => null,
          undefined,
          'acme-corp',
          'org-a'
        )
      ).toThrow(/ROLE_ASSUMPTION_DENIED/);
    });
  });

  it('matches writer binding and ignores the ambient project variable', () => {
    process.env.SYSTEM_ROLE = 'concierge';
    process.env.KYBERION_PROJECT_ID = 'foreign-project';
    runInResourceAccessScope(scope(), () => {
      expect(() =>
        withExecutionContext(
          'concierge_management_writer',
          () => null,
          undefined,
          'other-tenant',
          'org-a'
        )
      ).toThrow(/RESOURCE_SCOPE_REQUIRED/);
      withExecutionContext(
        'concierge_management_writer',
        () => {
          expect(validateWritePermission(abs(exact)).allowed).toBe(true);
          expect(
            validateWritePermission(abs('active/shared/runtime/projects/foreign-project.json'))
              .allowed
          ).toBe(false);
        },
        undefined,
        'acme-corp',
        'org-a'
      );
    });
  });

  it('supports tenant-only exact profile reads without any mutation', () => {
    process.env.SYSTEM_ROLE = 'concierge';
    const profile = 'knowledge/personal/tenants/acme-corp.json';
    runInResourceAccessScope(
      scope({
        organizationId: undefined,
        projectId: undefined,
        readExact: [profile],
        writeExact: [],
        mkdirExact: [],
      }),
      () => {
        withExecutionContext(
          'concierge_management_reader',
          () => {
            expect(validateReadPermission(abs(profile)).allowed).toBe(true);
            expect(
              validateReadPermission(abs('knowledge/personal/tenants/other-tenant.json')).allowed
            ).toBe(false);
            expect(validateWritePermission(abs(profile)).allowed).toBe(false);
          },
          undefined,
          'acme-corp'
        );
      }
    );
    runInResourceAccessScope(scope(), () => {
      expect(() =>
        withExecutionContext('concierge_management_reader', () => null, undefined, 'acme-corp')
      ).toThrow(/RESOURCE_SCOPE_REQUIRED/);
    });
  });
});
