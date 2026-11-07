import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  resourceAccessDenial,
  runInResourceAccessScope,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import { roleNarrowingDenial } from './role-narrowing-denial.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';

vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));
vi.mock('../governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));

const ROOT = pathResolver.rootDir();
const ENV = ['KYBERION_TENANT', 'KYBERION_SUDO', 'KYBERION_PERSONA', 'MISSION_ID'] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let exact: string;
let foreign: string;
const abs = (target: string) => path.resolve(ROOT, target);

/** A person-custody ceiling over catalog-declared personal material. */
const PERSON_CHARTER = 'knowledge/personal/charters/example.json';
/** A system-custody ceiling over product knowledge. */
const PRODUCT_DOC = 'knowledge/product/governance/example.json';

function tenantScope(overrides: Partial<ResourceAccessScope> = {}): ResourceAccessScope {
  return {
    tenantSlug: 'acme-corp',
    readExact: [exact],
    writeExact: [exact],
    mkdirExact: [base],
    ...overrides,
  };
}

function custodyScope(
  custody: ResourceAccessScope['custody'],
  overrides: Partial<ResourceAccessScope> = {}
): ResourceAccessScope {
  return {
    custody,
    readExact: [exact],
    writeExact: [exact],
    mkdirExact: [base],
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  base = 'active/shared/tmp/resource-custody-' + crypto.randomUUID();
  exact = base + '/nested/allowed.json';
  foreign = base + '/foreign.json';
  safeMkdir(abs(base));
  safeWriteFile(abs(foreign), 'foreign');
});

afterEach(() => {
  safeRmSync(abs(base), { recursive: true, force: true });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('G4 custody on the request ceiling', () => {
  it('normalizes an omitted custody to tenant (existing callers keep their scope)', () => {
    runInResourceAccessScope(tenantScope(), () => {
      const scope = currentResourceAccessScope()!;
      expect(scope.custody).toEqual({ kind: 'tenant' });
      expect(scope.tenantSlug).toBe('acme-corp');
      expect(validateWritePermission(abs(exact)).allowed).toBe(true);
      expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
    });
  });

  it('issues a grant over a system-custody asset — ceiling inside, denied outside', () => {
    runInResourceAccessScope(
      custodyScope(
        { kind: 'system' },
        { readExact: [PRODUCT_DOC, exact], allowProductKnowledgeRead: true }
      ),
      () => {
        const scope = currentResourceAccessScope()!;
        expect(scope.custody).toEqual({ kind: 'system' });
        expect(scope.tenantSlug).toBeUndefined();
        expect(validateReadPermission(abs(PRODUCT_DOC)).allowed).toBe(true);
        expect(validateWritePermission(abs(exact)).allowed).toBe(true);
        expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
      }
    );
  });

  it.each([{ kind: 'person' as const }, { kind: 'person' as const, ref: 'installation-owner' }])(
    'issues a grant over a person-custody asset (%s)',
    (custody) => {
      runInResourceAccessScope(
        custodyScope(custody, { readExact: [PERSON_CHARTER, exact] }),
        () => {
          const scope = currentResourceAccessScope()!;
          expect(scope.custody).toEqual(custody);
          expect(scope.tenantSlug).toBeUndefined();
          // The ceiling itself permits the declared personal path — custody is
          // not disclosure, so the persona gate still denies personal-tier
          // reads for a bare process (P4 wires the viewer path).
          expect(resourceAccessDenial(PERSON_CHARTER, 'read')).toBeNull();
          const personal = withExecutionContext(
            'worker',
            () => validateReadPermission(abs(PERSON_CHARTER)),
            'worker'
          );
          expect(personal.allowed).toBe(false);
          expect(personal.reason).not.toContain('RESOURCE_SCOPE');
          expect(validateWritePermission(abs(exact)).allowed).toBe(true);
          expect(validateWritePermission(abs(foreign)).allowed).toBe(false);
        }
      );
    }
  );

  it('fails closed on malformed custody declarations', () => {
    const nonTenantBindingError =
      '[RESOURCE_SCOPE_INVALID] Non-tenant custody cannot bind a tenant, organization or project';
    const personRefError = '[RESOURCE_SCOPE_INVALID] Invalid person custody ref';
    const unknownKindError = '[RESOURCE_SCOPE_INVALID] Unknown custody kind';
    for (const [scope, error] of [
      [{ custody: { kind: 'system' }, tenantSlug: 'acme-corp' }, nonTenantBindingError],
      [{ custody: { kind: 'system' }, organizationId: 'org-a' }, nonTenantBindingError],
      [{ custody: { kind: 'person' }, projectId: 'proj-a' }, nonTenantBindingError],
      [{ custody: { kind: 'person', ref: 'Bad Ref!' } }, personRefError],
      [{ custody: { kind: 'person', ref: 123 } }, personRefError],
      [{ custody: { kind: 'person', ref: '' } }, personRefError],
      [{ custody: { kind: 'person', ref: '   ' } }, personRefError],
      [{ custody: { kind: 'nobody' } }, unknownKindError],
      [{ custody: 'system' }, unknownKindError],
      [
        { custody: { kind: 'tenant' } },
        '[RESOURCE_SCOPE_INVALID] Missing or invalid resource binding',
      ],
    ] as const)
      expect(
        () =>
          runInResourceAccessScope(
            custodyScope(undefined, scope as unknown as Partial<ResourceAccessScope>),
            () => null
          ),
        JSON.stringify(scope)
      ).toThrow(error);
    // tenant custody with a slug still validates
    runInResourceAccessScope(custodyScope({ kind: 'tenant' }, { tenantSlug: 'acme-corp' }), () =>
      expect(currentResourceAccessScope()?.custody).toEqual({ kind: 'tenant' })
    );
  });

  it('cannot swap custody inside a nested binding', () => {
    runInResourceAccessScope(tenantScope(), () => {
      for (const inner of [
        custodyScope({ kind: 'system' }),
        custodyScope({ kind: 'person' }),
        tenantScope({ tenantSlug: 'other-tenant' }),
      ])
        expect(() => runInResourceAccessScope(inner, () => null)).toThrow(/RESOURCE_SCOPE_INVALID/);
    });
    runInResourceAccessScope(custodyScope({ kind: 'person', ref: 'installation-owner' }), () => {
      expect(() =>
        runInResourceAccessScope(custodyScope({ kind: 'person', ref: 'other-member' }), () => null)
      ).toThrow(/RESOURCE_SCOPE_INVALID/);
      // same custody nests fine
      runInResourceAccessScope(custodyScope({ kind: 'person', ref: 'installation-owner' }), () =>
        expect(currentResourceAccessScope()?.custody).toEqual({
          kind: 'person',
          ref: 'installation-owner',
        })
      );
    });
  });

  it('issues tenant-less grants through the synchronous issuer end to end', () => {
    const issuer = createSynchronousResourceGrantIssuer<{ label: string }>();
    const scope = custodyScope({ kind: 'person' }, { readExact: [PERSON_CHARTER] });
    const result = issuer.run({ label: 'charter-access' }, scope, () => {
      const live = currentResourceAccessScope()!;
      expect(issuer.resolve(live)?.scope).toBe(live);
      expect(resourceAccessDenial(PERSON_CHARTER, 'read')).toBeNull();
      expect(resourceAccessDenial(foreign, 'read')).not.toBeNull();
      return 'done';
    });
    expect(result).toBe('done');
    expect(issuer.resolve(currentResourceAccessScope())).toBeUndefined();
  });

  it('never lets a non-tenant custody create tenant tier partitions', () => {
    // The structural-mkdir shared checks require the scope tenant to equal the
    // partition tenant — a tenant-less custody has none and must fail closed.
    runInResourceAccessScope(custodyScope({ kind: 'system' }, { mkdirExact: [] }), () => {
      expect(
        validateWritePermission(abs('knowledge/confidential/acme-corp'), 'mkdir').allowed
      ).toBe(false);
      expect(
        validateWritePermission(abs('knowledge/personal/members/acme-corp'), 'mkdir').allowed
      ).toBe(false);
    });
  });
});

describe('narrow require_scope.custody declaration', () => {
  const policy = {
    authority_role_permissions: {
      person_only_role: { narrow: { require_scope: { custody: 'person' } } },
      system_or_person_role: {
        narrow: { require_scope: { custody: ['system', 'person'] } },
      },
    },
  };
  const deny = (role: string, scope: ResourceAccessScope | undefined) =>
    roleNarrowingDenial({
      policy,
      role,
      relativePath: 'knowledge/personal/charters/x.json',
      operation: 'read',
      scope,
      content: undefined,
      readRepoFile: () => undefined,
    });

  it('admits only a scope whose custody the declaration names', () => {
    expect(deny('person_only_role', undefined)).toContain('RESOURCE_SCOPE_REQUIRED');
    expect(
      deny('person_only_role', {
        tenantSlug: 'acme-corp',
        readExact: [],
        writeExact: [],
        mkdirExact: [],
      })
    ).toContain('RESOURCE_SCOPE_REQUIRED');
    expect(
      deny('person_only_role', {
        custody: { kind: 'system' },
        readExact: [],
        writeExact: [],
        mkdirExact: [],
      })
    ).toContain('RESOURCE_SCOPE_REQUIRED');
    expect(
      deny('person_only_role', {
        custody: { kind: 'person' },
        readExact: [],
        writeExact: [],
        mkdirExact: [],
      })
    ).toBeNull();
    expect(
      deny('system_or_person_role', {
        custody: { kind: 'system' },
        readExact: [],
        writeExact: [],
        mkdirExact: [],
      })
    ).toBeNull();
    // a scope literal without custody is tenant (derivation rule)
    expect(
      deny('system_or_person_role', {
        tenantSlug: 'acme-corp',
        readExact: [],
        writeExact: [],
        mkdirExact: [],
      })
    ).toContain('RESOURCE_SCOPE_REQUIRED');
  });
});
