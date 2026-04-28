import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';

const ROOT = pathResolver.rootDir();

describe('tier-guard tenant scope (IP-1)', () => {
  let savedTenant: string | undefined;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedSudo: string | undefined;
  let savedMission: string | undefined;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedSudo = process.env.KYBERION_SUDO;
    savedMission = process.env.MISSION_ID;
    delete process.env.MISSION_ID;
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (savedSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = savedSudo;
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
  });

  it('allows write inside the same tenant prefix', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/acme-corp/notes.md');
    const result = validateWritePermission(target);
    // Tenant scope passes; whatever else policy decides is fine.
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }
  });

  it('denies write to a different tenant prefix', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/notes.md');
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_violation/);
    expect(result.reason).toContain("tenant 'acme-corp'");
    expect(result.reason).toContain("tenant 'other-tenant'");
  });

  it('denies read from a different tenant prefix', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/secret.md');
    const result = validateReadPermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_violation/);
  });

  it('denies write to a different tenant active mission prefix', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(
      ROOT,
      'active/missions/confidential/other-tenant/MSN-FOO/evidence/leak.json',
    );
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_violation/);
  });

  it('SUDO bypasses tenant scope (cross-tenant tooling)', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_SUDO = 'true';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/file.md');
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }
  });

  it('persona without tenant binding is unaffected by tenant scope', () => {
    delete process.env.KYBERION_TENANT;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/file.md');
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }
  });

  it('legacy non-slug confidential paths are not tenant-scoped', () => {
    // Existing single-tenant layouts use confidential/{MSN-...}/ which are not slugs.
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(
      ROOT,
      'active/missions/confidential/MSN-LEGACY-MISSION/evidence/note.md',
    );
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }
  });

  it('rejects malformed tenant slug from env', async () => {
    process.env.KYBERION_TENANT = 'Acme Corp!';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const { resolveIdentityContext } = await import('./authority.js');
    const ctx = resolveIdentityContext();
    expect(ctx.tenantSlug).toBeUndefined();
  });
});

describe('tier-guard brokered missions (C8)', () => {
  let savedTenant: string | undefined;
  let savedPersona: string | undefined;
  let savedMission: string | undefined;
  const FIX_MISSION = 'MSN-BROKER-FIXTURE-001';

  beforeEach(async () => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    savedMission = process.env.MISSION_ID;
    // Build a fake mission state at active/missions/public/<MSN>/mission-state.json
    // so resolveIdentityContext picks up the brokerage.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ROOT = pathResolver.rootDir();
    const dir = path.join(ROOT, 'active/missions/public', FIX_MISSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mission-state.json'),
      JSON.stringify(
        {
          mission_id: FIX_MISSION,
          tier: 'public',
          assigned_persona: 'ecosystem_architect',
          cross_tenant_brokerage: {
            source_tenants: ['acme-corp', 'beta-co'],
            purpose: 'test broker',
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
    // Best-effort cleanup; do not fail test if tier-guard rejects (e.g. in CI sandboxes).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ROOT = pathResolver.rootDir();
    const dir = path.join(ROOT, 'active/missions/public', FIX_MISSION);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('broker mission: allows access to tenants in source_tenants list', () => {
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const targetA = path.join(ROOT, 'knowledge/confidential/acme-corp/notes.md');
    const a = validateWritePermission(targetA);
    if (!a.allowed) {
      expect(a.reason).not.toMatch(/tenant\.scope_violation/);
    }
    const targetB = path.join(ROOT, 'knowledge/confidential/beta-co/notes.md');
    const b = validateWritePermission(targetB);
    if (!b.allowed) {
      expect(b.reason).not.toMatch(/tenant\.scope_violation/);
    }
  });

  it('broker mission: still denies tenants outside source_tenants list', () => {
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/gamma-org/secret.md');
    const r = validateWritePermission(target);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/tenant\.scope_violation/);
  });

  it('non-broker mission: behaves like a regular tenant binding', async () => {
    // Switch to a fixture WITHOUT brokerage by using the non-existent
    // KYBERION_TENANT route only.
    delete process.env.MISSION_ID;
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/beta-co/secret.md');
    const r = validateWritePermission(target);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/tenant\.scope_violation/);
  });
});
