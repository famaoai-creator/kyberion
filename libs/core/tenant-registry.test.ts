import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultTenantKnowledgeRoot,
  ensureDefaultTenantProfile,
  listTenantProfileSlugs,
  pathResolver,
  resolveTenant,
  tenantProfilePath,
  writeTenantGroupProfile,
} from './index.js';
import type { TenantProfile } from './index.js';

const ROOT = pathResolver.rootDir();
const TENANT_DIR = path.join(ROOT, 'knowledge/personal/tenants');
const GROUP_DIR = path.join(ROOT, 'knowledge/confidential/tenant-groups');

describe('tenant-registry', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedTenant: string | undefined;
  let savedDefaultProfile: string | null;
  let savedUnitSharedGroup: string | null;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedTenant = process.env.KYBERION_TENANT;
    const defaultPath = path.join(TENANT_DIR, 'default.json');
    const groupPath = path.join(GROUP_DIR, 'unit-shared.json');
    savedDefaultProfile = fs.existsSync(defaultPath) ? fs.readFileSync(defaultPath, 'utf8') : null;
    savedUnitSharedGroup = fs.existsSync(groupPath) ? fs.readFileSync(groupPath, 'utf8') : null;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.KYBERION_TENANT;
  });

  afterEach(() => {
    const defaultPath = path.join(TENANT_DIR, 'default.json');
    const groupPath = path.join(GROUP_DIR, 'unit-shared.json');
    try {
      if (savedDefaultProfile === null) fs.rmSync(defaultPath, { force: true });
      else fs.writeFileSync(defaultPath, savedDefaultProfile);
    } catch {
      /* best-effort cleanup */
    }
    try {
      if (savedUnitSharedGroup === null) fs.rmSync(groupPath, { force: true });
      else fs.writeFileSync(groupPath, savedUnitSharedGroup);
    } catch {
      /* best-effort cleanup */
    }
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('bootstraps the default tenant profile when missing', () => {
    fs.rmSync(path.join(TENANT_DIR, 'default.json'), { force: true });
    const profile = ensureDefaultTenantProfile();
    expect(profile.tenant_slug).toBe('default');
    expect(fs.existsSync(tenantProfilePath('default'))).toBe(true);
  });

  it('writes a tenant group profile with normalized members and shared prefix', () => {
    const group = writeTenantGroupProfile({
      tenant_group_id: 'unit-shared',
      display_name: 'Unit Shared',
      status: 'active',
      member_tenants: ['acme-corp', 'beta-co', 'acme-corp'],
      shared_prefixes: [],
    });
    expect(group.member_tenants).toEqual(['acme-corp', 'beta-co']);
    expect(group.shared_prefixes).toEqual(['knowledge/confidential/shared/unit-shared/']);
  });

  it('rejects tenant group profiles that violate the shared prefix schema', () => {
    expect(() =>
      writeTenantGroupProfile({
        tenant_group_id: 'unit-shared',
        display_name: 'Unit Shared',
        status: 'active',
        member_tenants: ['acme-corp'],
        shared_prefixes: ['knowledge/public/shared/unit-shared/'],
      })
    ).toThrow(/invalid tenant group profile/i);
  });
});

// DA-01: resolveTenant is the single spine that maps a tenant slug to its
// knowledge root and customer overlay root. Hermetic: fixtures are seeded
// under a temp root (active/shared/tmp — the governed temp location) via the
// TenantRegistryPathOptions seam; the real knowledge/ tree is never touched.
describe('resolveTenant (DA-01 spine)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  const EMPTY_ENV = {} as NodeJS.ProcessEnv; // no KYBERION_CUSTOMER → personal tenants dir
  let fixtureRoot = '';

  beforeEach(() => {
    fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'tenant-registry-da01-'));
  });

  afterEach(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  function seedProfile(slug: string, extra: Partial<TenantProfile> = {}): void {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    const profile: TenantProfile = {
      tenant_slug: slug,
      display_name: `Tenant ${slug}`,
      status: 'active',
      assigned_role: 'owner',
      ...extra,
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(profile, null, 2));
  }

  it('resolves the default knowledge_root and a null overlay when no customer dir exists', () => {
    seedProfile('acme-corp');
    const resolved = resolveTenant('acme-corp', { rootDir: fixtureRoot, env: EMPTY_ENV });
    expect(resolved.profile.tenant_slug).toBe('acme-corp');
    expect(resolved.knowledge_root).toBe('knowledge/confidential/acme-corp');
    expect(resolved.knowledge_root).toBe(defaultTenantKnowledgeRoot('acme-corp'));
    expect(resolved.knowledge_root_path).toBe(
      path.join(fixtureRoot, 'knowledge', 'confidential', 'acme-corp')
    );
    expect(resolved.customer_overlay_root).toBeNull();
  });

  it('respects an explicit knowledge_root and resolves the customer overlay when present', () => {
    seedProfile('acme-corp', {
      knowledge_root: 'knowledge/confidential/acme-corp/main',
      ingest_sources: [{ source_system: 'confluence', enabled: true, note: 'pilot' }],
    });
    fs.mkdirSync(path.join(fixtureRoot, 'customer', 'acme-corp'), { recursive: true });
    const resolved = resolveTenant('acme-corp', { rootDir: fixtureRoot, env: EMPTY_ENV });
    expect(resolved.knowledge_root).toBe('knowledge/confidential/acme-corp/main');
    expect(resolved.knowledge_root_path).toBe(
      path.join(fixtureRoot, 'knowledge', 'confidential', 'acme-corp', 'main')
    );
    expect(resolved.customer_overlay_root).toBe(path.join(fixtureRoot, 'customer', 'acme-corp'));
    expect(resolved.profile.ingest_sources).toEqual([
      { source_system: 'confluence', enabled: true, note: 'pilot' },
    ]);
  });

  it('throws for a slug with no profile (unregistered tenants cannot resolve)', () => {
    expect(() => resolveTenant('ghost-co', { rootDir: fixtureRoot, env: EMPTY_ENV })).toThrow(
      /has no profile/
    );
  });

  // A refused/failed read used to be reported as "is not valid JSON", which sent
  // callers to inspect a file that was fine. The realistic cause is an
  // authorization failure on the personal tier (Sovereign Sanctuary), so the two
  // failures must stay distinguishable. A directory at the profile path is the
  // cross-platform way to make the read fail while the path still exists.
  it('reports an unreadable profile as a read failure, not as corrupt JSON', () => {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(path.join(dir, 'unreadable-co.json'), { recursive: true });
    let message = '';
    try {
      resolveTenant('unreadable-co', { rootDir: fixtureRoot, env: EMPTY_ENV });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/could not be read/);
    expect(message).not.toMatch(/not valid JSON/);
    // The hint is keyed off the personal-tier location, not the error text.
    expect(message).toMatch(/KYBERION_PERSONA/);
  });

  it('still reports genuinely corrupt profile JSON as a JSON failure', () => {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt-co.json'), '{ not json');
    expect(() => resolveTenant('corrupt-co', { rootDir: fixtureRoot, env: EMPTY_ENV })).toThrow(
      /is not valid JSON/
    );
  });

  it('rejects schema-invalid profiles instead of resolving them', () => {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'broken-co.json'),
      JSON.stringify({ tenant_slug: 'broken-co', status: 'active' })
    );
    expect(() => resolveTenant('broken-co', { rootDir: fixtureRoot, env: EMPTY_ENV })).toThrow(
      /invalid tenant profile/
    );
  });

  it('resolves every seeded tenant to exactly one knowledge_root + overlay pair', () => {
    seedProfile('acme-corp');
    seedProfile('beta-co');
    fs.mkdirSync(path.join(fixtureRoot, 'customer', 'beta-co'), { recursive: true });
    const options = { rootDir: fixtureRoot, env: EMPTY_ENV };
    const slugs = listTenantProfileSlugs(options);
    expect(slugs).toEqual(['acme-corp', 'beta-co']);
    const roots = slugs.map((slug) => resolveTenant(slug, options).knowledge_root);
    expect(new Set(roots).size).toBe(slugs.length);
    expect(resolveTenant('acme-corp', options).customer_overlay_root).toBeNull();
    expect(resolveTenant('beta-co', options).customer_overlay_root).toBe(
      path.join(fixtureRoot, 'customer', 'beta-co')
    );
  });

  // Acceptance (DA-01 #2): every tenant registered in THIS checkout resolves
  // uniquely. In CI checkouts the profile set is empty (gitignored personal
  // data) and this passes vacuously; on operator machines it pins the real set.
  it('resolves every registered tenant profile in the current checkout', () => {
    // Reading the real knowledge/personal/tenants dir requires an authorized
    // persona/role (Sovereign Sanctuary) — same env the sibling suite uses.
    const savedPersona = process.env.KYBERION_PERSONA;
    const savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      const seen = new Set<string>();
      for (const slug of listTenantProfileSlugs()) {
        const resolved = resolveTenant(slug);
        expect(resolved.knowledge_root.length).toBeGreaterThan(0);
        expect(resolved.knowledge_root_path).toBe(
          path.join(pathResolver.rootDir(), resolved.knowledge_root)
        );
        expect(seen.has(resolved.knowledge_root)).toBe(false);
        seen.add(resolved.knowledge_root);
      }
    } finally {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    }
  });
});
