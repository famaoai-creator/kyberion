import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import { withExecutionContext } from './authority.js';

vi.mock('./secure-io.js', async () => {
  const fsModule = await import('node:fs');
  return {
    safeExistsSync: fsModule.existsSync,
    safeReadFile: (filePath: string, options?: { encoding?: BufferEncoding | null }) =>
      fsModule.readFileSync(filePath, options?.encoding ?? 'utf8'),
    safeReaddir: fsModule.readdirSync,
    safeWriteFile: fsModule.writeFileSync,
    safeAppendFileSync: fsModule.appendFileSync,
    safeMkdir: fsModule.mkdirSync,
    rawExistsSync: fsModule.existsSync,
    rawReadTextFile: (filePath: string) => fsModule.readFileSync(filePath, 'utf8'),
  };
});

vi.mock('./audit-chain.js', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ROOT = pathResolver.rootDir();

describe('tier-guard tenant scope (IP-1)', () => {
  let savedTenant: string | undefined;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedSudo: string | undefined;
  let savedMission: string | undefined;
  let savedUnitSharedGroup: string | null;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedSudo = process.env.KYBERION_SUDO;
    savedMission = process.env.MISSION_ID;
    const groupPath = path.join(ROOT, 'knowledge/confidential/tenant-groups/unit-shared.json');
    savedUnitSharedGroup = fs.existsSync(groupPath) ? fs.readFileSync(groupPath, 'utf8') : null;
    delete process.env.MISSION_ID;
  });

  afterEach(() => {
    const groupPath = path.join(ROOT, 'knowledge/confidential/tenant-groups/unit-shared.json');
    try {
      if (savedUnitSharedGroup === null) fs.rmSync(groupPath, { force: true });
      else fs.writeFileSync(groupPath, savedUnitSharedGroup);
    } catch {}
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

  it('legacy active mission confidential paths are not tenant-scoped', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(
      ROOT,
      'active/missions/confidential/other-tenant/MSN-FOO/evidence/leak.json'
    );
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }
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

  it('allows run_pipeline to persist traces and temp artifacts', () => {
    process.env.KYBERION_CUSTOMER = 'story-demo';
    const traceTarget = path.join(ROOT, 'customer/story-demo/logs/traces/traces-2026-05-08.jsonl');
    const tmpTarget = path.join(ROOT, 'active/shared/tmp/pipeline-step.json');
    const productVoiceProfileTarget = path.join(
      ROOT,
      'knowledge/product/governance/voice-profiles/test-profile.json'
    );
    const personalVoiceProfileOverlay = path.join(
      ROOT,
      'knowledge/personal/voice/profile-registry.json'
    );
    const unrelatedPersonalTarget = path.join(ROOT, 'knowledge/personal/other/private.json');

    withExecutionContext(
      'run_pipeline',
      () => {
        expect(validateReadPermission(personalVoiceProfileOverlay).allowed).toBe(true);
        expect(validateReadPermission(unrelatedPersonalTarget).allowed).toBe(false);
        expect(validateWritePermission(traceTarget).allowed).toBe(true);
        expect(validateWritePermission(tmpTarget).allowed).toBe(true);
        expect(validateWritePermission(personalVoiceProfileOverlay).allowed).toBe(true);
        expect(validateWritePermission(productVoiceProfileTarget).allowed).toBe(false);
      },
      'unknown'
    );
  });

  it('allows run_super_pipeline to write temporary dispatch artifacts', () => {
    process.env.KYBERION_CUSTOMER = 'story-demo';
    const traceTarget = path.join(ROOT, 'customer/story-demo/logs/traces/traces-2026-05-08.jsonl');
    const tmpTarget = path.join(ROOT, 'active/shared/tmp/super-pipeline.json');

    withExecutionContext(
      'run_super_pipeline',
      () => {
        expect(validateWritePermission(traceTarget).allowed).toBe(true);
        expect(validateWritePermission(tmpTarget).allowed).toBe(true);
      },
      'unknown'
    );
  });

  it('legacy non-slug confidential paths are not tenant-scoped', () => {
    // Existing single-tenant layouts use confidential/{MSN-...}/ which are not slugs.
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(
      ROOT,
      'active/missions/confidential/MSN-LEGACY-MISSION/evidence/note.md'
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

  it('allows a tenant to access its active confidential shared group', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const dir = path.join(ROOT, 'knowledge/confidential/tenant-groups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'unit-shared.json'),
      JSON.stringify({
        tenant_group_id: 'unit-shared',
        display_name: 'Unit Shared',
        status: 'active',
        member_tenants: ['acme-corp', 'beta-co'],
        shared_prefixes: ['knowledge/confidential/shared/unit-shared/'],
      })
    );

    const target = path.join(ROOT, 'knowledge/confidential/shared/unit-shared/brief.md');
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.group_scope_violation|tenant\.group_unknown/);
    }
  });

  it('denies a tenant outside a confidential shared group', () => {
    process.env.KYBERION_TENANT = 'gamma-org';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const dir = path.join(ROOT, 'knowledge/confidential/tenant-groups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'unit-shared.json'),
      JSON.stringify({
        tenant_group_id: 'unit-shared',
        display_name: 'Unit Shared',
        status: 'active',
        member_tenants: ['acme-corp', 'beta-co'],
        shared_prefixes: ['knowledge/confidential/shared/unit-shared/'],
      })
    );

    const target = path.join(ROOT, 'knowledge/confidential/shared/unit-shared/brief.md');
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.group_scope_violation/);
  });

  it('denies shared group access when the group registry entry is malformed', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const dir = path.join(ROOT, 'knowledge/confidential/tenant-groups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'unit-shared.json'),
      JSON.stringify({
        tenant_group_id: 'unit-shared',
        display_name: 'Unit Shared',
        status: 'active',
        member_tenants: ['acme-corp'],
        shared_prefixes: ['knowledge/public/shared/unit-shared/'],
      })
    );

    const target = path.join(ROOT, 'knowledge/confidential/shared/unit-shared/brief.md');
    const result = validateReadPermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.group_unknown/);
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
            approved_by: 'qa-lead',
            approved_at: '2026-01-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        },
        null,
        2
      )
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
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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

  it('broker mission: emits a tenant.broker_access audit entry', async () => {
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/acme-corp/audit-marker.md');
    const result = validateWritePermission(target);
    if (!result.allowed) {
      expect(result.reason).not.toMatch(/tenant\.scope_violation/);
    }

    const { auditChain } = await import('./audit-chain.js');
    expect(vi.mocked(auditChain.record)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.broker_access',
        operation: 'knowledge/confidential/acme-corp/audit-marker.md',
        metadata: expect.objectContaining({
          target_tenant: 'acme-corp',
          broker_tenants: ['acme-corp', 'beta-co'],
        }),
      })
    );
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

  it('broker mission: denies when brokerage is expired', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(ROOT, 'active/missions/public', FIX_MISSION);
    fs.writeFileSync(
      path.join(dir, 'mission-state.json'),
      JSON.stringify(
        {
          mission_id: FIX_MISSION,
          tier: 'public',
          assigned_persona: 'ecosystem_architect',
          cross_tenant_brokerage: {
            source_tenants: ['acme-corp'],
            purpose: 'expired broker',
            approved_by: 'qa-lead',
            approved_at: '2026-01-01T00:00:00.000Z',
            expires_at: '2000-01-01T00:00:00.000Z',
          },
        },
        null,
        2
      )
    );
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/acme-corp/secret.md');
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.broker_expired/);
  });
});
