// FD-01: buildFrontDeskMe is pure (no fixture root needed); readFrontDeskMe
// is exercised hermetically against a fixture rootDir under
// active/shared/tmp via the TenantRegistryPathOptions seam (same pattern as
// tenant-registry.test.ts / ingest-asset-ledger.test.ts) — no real
// knowledge/ file is touched.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import { writeTenantProfile, type TenantProfile } from './tenant-registry.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

vi.mock('./operator-identity.js', () => ({
  resolveOperatorDisplayName: vi.fn((fallback?: string) => `mocked-operator(${fallback ?? ''})`),
}));

import {
  buildFrontDeskMe,
  frontDeskRoleFromViewerScope,
  readFrontDeskMe,
  type BuildFrontDeskMeInput,
} from './front-desk-identity.js';

function makeScope(overrides: Partial<SurfaceViewerScope> = {}): SurfaceViewerScope {
  return {
    role: 'readonly',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'token',
    principalId: 'alice',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<TenantProfile> = {}): TenantProfile {
  return {
    tenant_slug: 'default',
    display_name: 'Default Tenant',
    status: 'active',
    assigned_role: 'owner',
    ...overrides,
  };
}

function makeInput(overrides: Partial<BuildFrontDeskMeInput> = {}): BuildFrontDeskMeInput {
  return {
    scope: makeScope(),
    availableOperations: ['presence.overview.read'],
    onboarded: true,
    tenantProfiles: [makeProfile()],
    ...overrides,
  };
}

describe('frontDeskRoleFromViewerScope', () => {
  it('maps localadmin to owner', () => {
    expect(frontDeskRoleFromViewerScope({ role: 'localadmin' })).toBe('owner');
  });

  it('maps readonly to viewer', () => {
    expect(frontDeskRoleFromViewerScope({ role: 'readonly' })).toBe('viewer');
  });
});

describe('buildFrontDeskMe', () => {
  it("includes every profile when the scope's tenantSlugs is 'all'", () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: 'all' }),
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.tenants.map((t) => t.tenant_slug)).toEqual(['acme-corp', 'beta-co']);
  });

  it('narrows to the explicit tenantSlugs list', () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: ['beta-co'] }),
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.tenants.map((t) => t.tenant_slug)).toEqual(['beta-co']);
  });

  it('sorts tenants by display_name', () => {
    const result = buildFrontDeskMe(
      makeInput({
        tenantProfiles: [
          makeProfile({ tenant_slug: 'zeta', display_name: 'Zeta' }),
          makeProfile({ tenant_slug: 'alpha', display_name: 'Alpha' }),
          makeProfile({ tenant_slug: 'mika', display_name: 'Mika' }),
        ],
      })
    );
    expect(result.tenants.map((t) => t.display_name)).toEqual(['Alpha', 'Mika', 'Zeta']);
  });

  it('selects the requested tenant when it narrows validly', () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: ['acme-corp', 'beta-co'] }),
        requestedTenant: 'beta-co',
        writeTenant: 'acme-corp',
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.viewing?.tenant_slug).toBe('beta-co');
  });

  it('ignores a requested tenant outside the scope and never widens', () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: ['acme-corp'] }),
        requestedTenant: 'beta-co',
        writeTenant: 'acme-corp',
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    // beta-co must never appear, even though it exists as a profile.
    expect(result.tenants.map((t) => t.tenant_slug)).toEqual(['acme-corp']);
    expect(result.viewing?.tenant_slug).toBe('acme-corp');
  });

  it('falls back to write_tenant when requestedTenant is absent', () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: ['acme-corp', 'beta-co'] }),
        writeTenant: 'beta-co',
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.viewing?.tenant_slug).toBe('beta-co');
  });

  it('never defaults viewing to an archived tenant', () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ tenantSlugs: ['acme-corp', 'beta-co'] }),
        writeTenant: 'acme-corp',
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp', status: 'archived' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.viewing?.tenant_slug).toBe('beta-co');
    // Archived tenants are still listed, just never chosen as the default.
    expect(result.tenants.map((t) => t.tenant_slug)).toEqual(['acme-corp', 'beta-co']);
  });

  it('returns null viewing when every tenant is archived', () => {
    const result = buildFrontDeskMe(
      makeInput({
        writeTenant: 'default',
        tenantProfiles: [makeProfile({ status: 'archived' })],
      })
    );
    expect(result.viewing).toBeNull();
  });

  it('reports can_switch only when more than one tenant is visible', () => {
    const single = buildFrontDeskMe(makeInput({ tenantProfiles: [makeProfile()] }));
    expect(single.can_switch).toBe(false);

    const multiple = buildFrontDeskMe(
      makeInput({
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(multiple.can_switch).toBe(true);
  });

  it("applies the viewer's role to every visible tenant", () => {
    const result = buildFrontDeskMe(
      makeInput({
        scope: makeScope({ role: 'localadmin' }),
        tenantProfiles: [
          makeProfile({ tenant_slug: 'acme-corp', display_name: 'Acme Corp' }),
          makeProfile({ tenant_slug: 'beta-co', display_name: 'Beta Co' }),
        ],
      })
    );
    expect(result.tenants.every((t) => t.role === 'owner')).toBe(true);
  });

  it('keeps the tenant profile assigned_role as informational', () => {
    const result = buildFrontDeskMe(
      makeInput({ tenantProfiles: [makeProfile({ assigned_role: 'approver' })] })
    );
    expect(result.tenants[0].assigned_role).toBe('approver');
    expect(result.tenants[0].role).toBe('viewer');
  });

  it('uses displayName over principalId over anonymous for member.display_name', () => {
    const withDisplayName = buildFrontDeskMe(
      makeInput({ scope: makeScope({ principalId: 'alice' }), displayName: 'Alice A.' })
    );
    expect(withDisplayName.member).toEqual({
      member_id: 'alice',
      display_name: 'Alice A.',
      source: 'token',
    });

    const withoutDisplayName = buildFrontDeskMe(
      makeInput({ scope: makeScope({ principalId: 'alice' }) })
    );
    expect(withoutDisplayName.member.display_name).toBe('alice');
  });

  it('falls back to anonymous when there is no principalId or displayName', () => {
    const result = buildFrontDeskMe(
      makeInput({ scope: makeScope({ principalId: undefined, source: 'anonymous' }) })
    );
    expect(result.member).toEqual({
      member_id: 'anonymous',
      display_name: 'anonymous',
      source: 'anonymous',
    });
  });

  it('echoes available_operations and onboarded through unchanged', () => {
    const result = buildFrontDeskMe(
      makeInput({ availableOperations: ['a.read', 'b.write'], onboarded: false })
    );
    expect(result.available_operations).toEqual(['a.read', 'b.write']);
    expect(result.onboarded).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe('readFrontDeskMe', () => {
  let fixtureRoot = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedTenant: string | undefined;

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `front-desk-identity-${randomUUID()}`
    );
    // Tenant profiles live under the personal tier: an authorized execution
    // context is required to write/read them, same as tenant-registry.test.ts.
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';

    writeTenantProfile(
      {
        tenant_slug: 'acme-corp',
        display_name: 'Acme Corp',
        status: 'active',
        assigned_role: 'owner',
      },
      { rootDir: fixtureRoot }
    );
    writeTenantProfile(
      {
        tenant_slug: 'beta-co',
        display_name: 'Beta Co',
        status: 'active',
        assigned_role: 'viewer',
      },
      { rootDir: fixtureRoot }
    );
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = 'acme-corp';
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    vi.clearAllMocks();
  });

  it('assembles the full payload from tenant-registry + operator-identity for a loopback viewer', () => {
    const scope = makeScope({ source: 'loopback', role: 'localadmin', principalId: 'famao' });
    const result = readFrontDeskMe(scope, {
      availableOperations: ['presence.overview.read'],
      onboarded: true,
      tenantRegistry: { rootDir: fixtureRoot },
    });

    expect(result.tenants.map((t) => t.tenant_slug)).toEqual(['acme-corp', 'beta-co']);
    expect(result.tenants.every((t) => t.role === 'owner')).toBe(true);
    expect(result.write_tenant).toBe('acme-corp');
    expect(result.viewing?.tenant_slug).toBe('acme-corp');
    expect(result.can_switch).toBe(true);
    expect(result.member).toEqual({
      member_id: 'famao',
      display_name: 'mocked-operator(famao)',
      source: 'loopback',
    });
    expect(result.onboarded).toBe(true);
    expect(result.available_operations).toEqual(['presence.overview.read']);
  });

  it('honors a valid requestedTenant narrowing for a token viewer without calling operator-identity', () => {
    const scope = makeScope({
      source: 'token',
      role: 'readonly',
      tenantSlugs: ['acme-corp', 'beta-co'],
      principalId: 'audit-token',
    });
    const result = readFrontDeskMe(scope, {
      requestedTenant: 'beta-co',
      availableOperations: [],
      onboarded: true,
      tenantRegistry: { rootDir: fixtureRoot },
    });

    expect(result.viewing?.tenant_slug).toBe('beta-co');
    expect(result.member.display_name).toBe('audit-token');
  });
});
