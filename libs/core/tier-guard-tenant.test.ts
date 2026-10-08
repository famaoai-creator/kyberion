import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  isValidTenantGroupProfile,
  normalizeRegisteredTenantProfile,
  validateReadPermission,
  validateWritePermission,
} from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { setLogFileSink } from './logger.js';

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
    loadJsonIfPresent: () => null,
    rawExistsSync: fsModule.existsSync,
    rawReadTextFile: (filePath: string) => fsModule.readFileSync(filePath, 'utf8'),
  };
});

vi.mock('./governance/audit-chain.js', () => ({
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
  let savedProject: string | undefined;
  let savedScopeEnvPath: string | undefined;
  let savedTenantScopeRequired: string | undefined;
  let savedUnitSharedGroup: string | null;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedSudo = process.env.KYBERION_SUDO;
    savedMission = process.env.MISSION_ID;
    savedProject = process.env.KYBERION_PROJECT_ID;
    savedScopeEnvPath = process.env.KYBERION_SCOPE_ENV_PATH;
    savedTenantScopeRequired = process.env.KYBERION_TENANT_SCOPE_REQUIRED;
    const groupPath = path.join(ROOT, 'knowledge/confidential/tenant-groups/unit-shared.json');
    savedUnitSharedGroup = fs.existsSync(groupPath) ? fs.readFileSync(groupPath, 'utf8') : null;
    delete process.env.MISSION_ID;
  });

  afterEach(() => {
    const groupPath = path.join(ROOT, 'knowledge/confidential/tenant-groups/unit-shared.json');
    try {
      if (savedUnitSharedGroup === null) fs.rmSync(groupPath, { force: true });
      else fs.writeFileSync(groupPath, savedUnitSharedGroup);
    } catch {
      /* best-effort cleanup */
    }
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
    if (savedProject === undefined) delete process.env.KYBERION_PROJECT_ID;
    else process.env.KYBERION_PROJECT_ID = savedProject;
    if (savedScopeEnvPath === undefined) delete process.env.KYBERION_SCOPE_ENV_PATH;
    else process.env.KYBERION_SCOPE_ENV_PATH = savedScopeEnvPath;
    if (savedTenantScopeRequired === undefined) delete process.env.KYBERION_TENANT_SCOPE_REQUIRED;
    else process.env.KYBERION_TENANT_SCOPE_REQUIRED = savedTenantScopeRequired;
  });

  it('normalizes tenant authority records and rejects malformed group membership', () => {
    expect(
      normalizeRegisteredTenantProfile({ tenant_slug: 'acme-corp', status: 'active' })
    ).toEqual({
      tenant_slug: 'acme-corp',
      status: 'active',
    });
    expect(normalizeRegisteredTenantProfile([])).toBeNull();
    expect(normalizeRegisteredTenantProfile({ tenant_slug: 'acme-corp', status: 1 })).toBeNull();
    expect(
      isValidTenantGroupProfile('unit-shared', {
        tenant_group_id: 'unit-shared',
        status: 'active',
        member_tenants: ['acme-corp', 7],
        shared_prefixes: ['knowledge/confidential/shared/unit-shared/'],
      })
    ).toBe(false);
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
    if (result.reason?.includes('tenant.scope_violation')) {
      expect(result.reason).toContain("tenant 'other-tenant'");
    }
  });

  it('denies read from a different tenant prefix', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/secret.md');
    const result = validateReadPermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_violation/);
  });

  it('treats the tenant design-override index as a shared registry, not a tenant named "tenants"', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const index = validateReadPermission(
      path.join(ROOT, 'knowledge/confidential/tenants/index.json')
    );
    if (!index.allowed) expect(index.reason).not.toMatch(/tenant\.scope_violation/);
    // Only the registry file is shared; the directory is not a free-for-all.
    const sibling = validateReadPermission(
      path.join(ROOT, 'knowledge/confidential/tenants/other.json')
    );
    expect(sibling.allowed).toBe(false);
    expect(sibling.reason).toMatch(/tenant\.scope_violation/);
  });

  it.each([
    ['mission', 'active/missions/confidential/other-tenant/MSN-FOO/evidence/leak.json'],
    ['project', 'active/projects/confidential/other-tenant/PRJ-FOO/state.json'],
  ])('denies and audits cross-tenant %s writes', async (_kind, relativePath) => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, relativePath);
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_violation/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { auditChain } = await import('./governance/audit-chain.js');
    expect(vi.mocked(auditChain.record)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.scope_violation', result: 'denied' })
    );
  });

  it('limits worker public project writes to the bound project and public partition', () => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PROJECT_ID = 'PRJ-TG-PUBLIC';

    expect(
      validateWritePermission(
        path.join(ROOT, 'active/projects/public/shared/PRJ-TG-PUBLIC/notes.md')
      ).allowed
    ).toBe(true);
    expect(
      validateWritePermission(
        path.join(ROOT, 'active/projects/public/acme-corp/PRJ-TG-PUBLIC/notes.md')
      ).allowed
    ).toBe(true);
    expect(
      validateWritePermission(
        path.join(ROOT, 'active/projects/public/beta-co/PRJ-TG-PUBLIC/notes.md')
      ).allowed
    ).toBe(false);
    expect(
      validateWritePermission(
        path.join(ROOT, 'active/projects/public/shared/PRJ-TG-OTHER/notes.md')
      ).allowed
    ).toBe(false);
  });

  it('uses the persisted project binding for worker tier policy when env is unset', () => {
    const scopePath = path.join(ROOT, 'active/shared/tmp/tier-guard-persisted-project-scope.env');
    fs.rmSync(scopePath, { force: true });
    process.env.KYBERION_SCOPE_ENV_PATH = scopePath;
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    delete process.env.KYBERION_TENANT;
    delete process.env.KYBERION_PROJECT_ID;
    delete process.env.MISSION_ID;
    fs.writeFileSync(
      scopePath,
      'KYBERION_PROJECT_ID=PRJ-TG-PERSISTED\nKYBERION_TENANT=acme-corp\nMISSION_ID=MSN-TG-PERSISTED\n',
      'utf8'
    );

    try {
      const allowed = validateWritePermission(
        path.join(ROOT, 'active/projects/confidential/acme-corp/PRJ-TG-PERSISTED/notes.md')
      );
      const denied = validateWritePermission(
        path.join(ROOT, 'active/projects/confidential/acme-corp/PRJ-TG-OTHER/notes.md')
      );
      const missionEvidence = validateWritePermission(
        path.join(
          ROOT,
          'active/missions/confidential/acme-corp/MSN-TG-PERSISTED/evidence/result.json'
        )
      );
      const otherMissionEvidence = validateWritePermission(
        path.join(ROOT, 'active/missions/confidential/acme-corp/MSN-TG-OTHER/evidence/result.json')
      );
      const foreignTenantEvidence = validateWritePermission(
        path.join(
          ROOT,
          'active/missions/confidential/beta-co/MSN-TG-PERSISTED/evidence/result.json'
        )
      );
      expect(allowed.allowed).toBe(true);
      expect(denied.allowed).toBe(false);
      expect(missionEvidence.allowed).toBe(true);
      expect(otherMissionEvidence.allowed).toBe(false);
      expect(foreignTenantEvidence.allowed).toBe(false);
    } finally {
      fs.rmSync(scopePath, { force: true });
    }
  });

  it.each(['tmp', 'staging', 'cache', 'artifacts'])(
    'isolates tenant partitions of the %s storage floor',
    (floor) => {
      process.env.KYBERION_TENANT = 'acme-corp';
      process.env.KYBERION_PERSONA = 'ecosystem_architect';
      const own = path.join(ROOT, `active/shared/${floor}/confidential/acme-corp/d/x.json`);
      const other = path.join(ROOT, `active/shared/${floor}/confidential/other-tenant/d/x.json`);
      const untenanted = path.join(ROOT, `active/shared/${floor}/confidential/shared/d/x.json`);

      expect(validateWritePermission(own).allowed).toBe(true);
      expect(validateReadPermission(own).allowed).toBe(true);
      const write = validateWritePermission(other);
      expect(write.allowed).toBe(false);
      expect(write.reason).toMatch(/tenant\.scope_violation/);
      const read = validateReadPermission(other);
      expect(read.allowed).toBe(false);
      expect(read.reason).toMatch(/tenant\.scope_violation/);
      // A tenant-bound persona never lands in the untenanted confidential partition.
      expect(validateWritePermission(untenanted).allowed).toBe(false);
    }
  );

  it('gates reads of confidential storage floors by tier, not system or legacy paths', () => {
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_PERSONA = 'worker';

    expect(
      validateReadPermission(path.join(ROOT, 'active/shared/cache/confidential/acme-corp/d/x'))
        .allowed
    ).toBe(false);
    expect(validateReadPermission(path.join(ROOT, 'active/shared/cache/system/d/x')).allowed).toBe(
      true
    );
    expect(validateReadPermission(path.join(ROOT, 'active/shared/cache/ki-x.json')).allowed).toBe(
      true
    );
    expect(
      validateReadPermission(path.join(ROOT, 'active/shared/artifacts/public/shared/r.md')).allowed
    ).toBe(true);
    // The worker's pre-partition `active/shared/tmp/` grant still covers legacy
    // tmp, but no longer reaches the protected tmp partitions.
    expect(validateReadPermission(path.join(ROOT, 'active/shared/tmp/job/x.json')).allowed).toBe(
      true
    );
    expect(
      validateReadPermission(path.join(ROOT, 'active/shared/tmp/confidential/acme-corp/x.json'))
        .allowed
    ).toBe(false);
    expect(
      validateReadPermission(path.join(ROOT, 'active/shared/tmp/personal/shared/x.json')).allowed
    ).toBe(false);
  });

  it('lets the Chronos operator read its tenant partition of the artifact floor only', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    withExecutionContext(
      'chronos_operator',
      () => {
        expect(
          validateReadPermission(
            path.join(ROOT, 'active/shared/artifacts/confidential/acme-corp/report/w.md')
          ).allowed
        ).toBe(true);
        expect(
          validateReadPermission(
            path.join(ROOT, 'active/shared/artifacts/confidential/other-tenant/report/w.md')
          ).allowed
        ).toBe(false);
      },
      'worker'
    );
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

  it('fails closed when a protected tenant path has no tenant binding', async () => {
    delete process.env.KYBERION_TENANT;
    // Registered boolean settings use the canonical 1/0 representation at
    // runtime; the guard must not compare the normalized text with "true".
    process.env.KYBERION_TENANT_SCOPE_REQUIRED = '1';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/file.md');
    const result = validateWritePermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.scope_missing/);
    const { auditChain } = await import('./governance/audit-chain.js');
    expect(vi.mocked(auditChain.record)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.scope_violation', result: 'denied' })
    );
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

  it('legacy non-slug confidential paths remain outside tenant scope until migrated', () => {
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

  it('allows the bound legacy mission path during tenant storage migration', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ID = 'MSN-LEGACY-MISSION';
    const target = path.join(
      ROOT,
      'active/missions/confidential/MSN-LEGACY-MISSION/team-composition.json'
    );
    expect(validateWritePermission(target).allowed).toBe(true);
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
      // Group membership passed, so no tenant-scope rule may deny it either:
      // the `shared` path segment is not a tenant.
      expect(result.reason).not.toMatch(/tenant\.[a-z_]+/);
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

  it('denies a tenant group that uses a reserved scope name as a member', () => {
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
        member_tenants: ['shared'],
        shared_prefixes: ['knowledge/confidential/shared/unit-shared/'],
      })
    );

    const target = path.join(ROOT, 'knowledge/confidential/shared/unit-shared/brief.md');
    const result = validateReadPermission(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/tenant\.group_unknown/);
  });

  it('limits worker reads of confidential project state to the bound tenant and project', () => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.KYBERION_PROJECT_ID = 'PRJ-ACME-OPS';

    const ownProject = path.join(
      ROOT,
      'active/projects/confidential/acme-corp/PRJ-ACME-OPS/state.json'
    );
    const otherProject = path.join(
      ROOT,
      'active/projects/confidential/acme-corp/PRJ-OTHER/state.json'
    );
    const otherTenant = path.join(
      ROOT,
      'active/projects/confidential/other-tenant/PRJ-ACME-OPS/state.json'
    );

    expect(validateReadPermission(ownProject).allowed).toBe(true);
    expect(validateReadPermission(otherProject).allowed).toBe(false);
    expect(validateReadPermission(otherTenant).allowed).toBe(false);
    expect(validateWritePermission(ownProject).allowed).toBe(true);
    expect(validateWritePermission(otherProject).allowed).toBe(false);
  });

  describe('bounded tenant audit sink failures', () => {
    const target = path.join(ROOT, 'knowledge/confidential/other-tenant/private-audit-probe.md');
    const nestedTarget = path.join(ROOT, 'knowledge/confidential/another-tenant/private-sink.md');
    const groupTarget = path.join(ROOT, 'knowledge/confidential/shared/unit-shared/brief.md');
    const settleAudits = () => vi.dynamicImportSettled();
    let stderr: ReturnType<typeof vi.spyOn>;
    let savedArgv: string[];

    beforeEach(async () => {
      // Earlier permission tests intentionally leave best-effort audits queued.
      // Drain those before installing this test's failure/reentrancy behavior.
      await settleAudits();
      const { auditChain } = await import('./governance/audit-chain.js');
      vi.mocked(auditChain.record).mockReset();
      process.env.KYBERION_TENANT = 'acme-corp';
      process.env.KYBERION_TENANT_SCOPE_REQUIRED = '0';
      process.env.KYBERION_PERSONA = 'ecosystem_architect';
      delete process.env.KYBERION_SUDO;
      savedArgv = process.argv;
      process.argv = [...process.argv, '--json'];
      vi.stubEnv('LOG_LEVEL', 'silent');
      stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(async () => {
      await settleAudits();
      const { auditChain } = await import('./governance/audit-chain.js');
      vi.mocked(auditChain.record).mockReset();
      setLogFileSink(null);
      stderr.mockRestore();
      process.argv = savedArgv;
      vi.unstubAllEnvs();
    });

    function seedSharedGroup(): void {
      const dir = path.join(ROOT, 'knowledge/confidential/tenant-groups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'unit-shared.json'),
        JSON.stringify({
          tenant_group_id: 'unit-shared',
          status: 'active',
          member_tenants: ['acme-corp'],
          shared_prefixes: ['knowledge/confidential/shared/unit-shared/'],
        })
      );
    }

    it('bounds nested denied writes even when record returns, preserving the first event', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      const nestedDecisions: ReturnType<typeof validateWritePermission>[] = [];
      record.mockImplementation((entry) => {
        // The cap lets a regressed implementation fail rather than spin forever.
        if (record.mock.calls.length < 8) {
          for (let index = 0; index < 3; index += 1) {
            nestedDecisions.push(validateWritePermission(nestedTarget));
          }
        }
        return entry as ReturnType<typeof auditChain.record>;
      });

      const decision = validateWritePermission(target);
      await settleAudits();

      expect(decision.allowed).toBe(false);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        agentId: 'tier-guard',
        action: 'tenant.scope_violation',
        operation: 'knowledge/confidential/other-tenant/private-audit-probe.md',
        result: 'denied',
        reason: decision.reason,
        tenantSlug: 'acme-corp',
        metadata: { target_tenant: 'other-tenant' },
      });
      expect(nestedDecisions).toHaveLength(3);
      expect(nestedDecisions.every((result) => !result.allowed)).toBe(true);
      expect(stderr).toHaveBeenCalledTimes(1);
      const diagnostic = String(stderr.mock.calls[0][0]);
      expect(diagnostic).toContain('Tenant access audit persistence unverified');
      expect(diagnostic).not.toMatch(/acme-corp|other-tenant|another-tenant|private-/);
    });

    it('emits only one failure when a nested denial is followed by a thrown sink error', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      record.mockImplementation(() => {
        if (record.mock.calls.length < 8) validateWritePermission(nestedTarget);
        throw new Error('private sink failure details');
      });

      expect(validateWritePermission(target).allowed).toBe(false);
      await settleAudits();

      expect(record).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).not.toContain('private sink failure details');
    });

    it('attempts every independent denial queued before import resolves and resets after errors', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      let firstAttempt = true;
      record.mockImplementation((entry) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('unavailable');
        }
        return entry as ReturnType<typeof auditChain.record>;
      });

      const first = validateWritePermission(target);
      const second = validateWritePermission(nestedTarget);
      expect(first.reason).toContain('tenant.scope_violation');
      expect(second.reason).toContain('tenant.scope_violation');
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(record.mock.calls.map(([entry]) => entry.operation)).toEqual([
        'knowledge/confidential/other-tenant/private-audit-probe.md',
        'knowledge/confidential/another-tenant/private-sink.md',
      ]);
      expect(stderr).toHaveBeenCalledTimes(1);

      expect(validateWritePermission(target).allowed).toBe(false);
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(3);
      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it('does not retry a broken diagnostic stream or leave the audit guard set', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      record.mockImplementationOnce(() => {
        throw new Error('sink unavailable');
      });
      stderr.mockImplementationOnce(() => {
        throw new Error('stderr unavailable');
      });

      expect(validateWritePermission(target).allowed).toBe(false);
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);

      expect(validateWritePermission(nestedTarget).allowed).toBe(false);
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it('reports through the shared console without invoking a failing process-file sink', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const fileSink = vi.fn(() => {
        validateWritePermission(nestedTarget);
        throw new Error('process log denied');
      });
      setLogFileSink(fileSink);
      vi.mocked(auditChain.record).mockImplementationOnce(() => {
        throw new Error('audit denied');
      });

      expect(validateWritePermission(target).allowed).toBe(false);
      await settleAudits();

      expect(auditChain.record).toHaveBeenCalledTimes(1);
      expect(fileSink).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it('suppresses nested allowed group auditing without claiming persistence failed', async () => {
      seedSharedGroup();
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      record.mockImplementation((entry) => {
        if (record.mock.calls.length < 8) validateWritePermission(groupTarget);
        return entry as ReturnType<typeof auditChain.record>;
      });

      expect(validateWritePermission(target).allowed).toBe(false);
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(1);
      expect(stderr).not.toHaveBeenCalled();

      validateWritePermission(groupTarget);
      await settleAudits();
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[1][0].action).toBe('tenant.group_access');
      expect(stderr).not.toHaveBeenCalled();
    });

    it('persists the initial denied event through a healthy real audit chain', async () => {
      const { auditChain } = await import('./governance/audit-chain.js');
      const actual = await vi.importActual<typeof import('./governance/audit-chain.js')>(
        './governance/audit-chain.js'
      );
      let recorded: ReturnType<typeof actual.auditChain.record> | undefined;
      vi.mocked(auditChain.record).mockImplementation((entry) => {
        // The shared test bootstrap supplies a sandboxed durable audit/lock IO.
        recorded = actual.auditChain.record(entry);
        return recorded;
      });

      const decision = validateWritePermission(target);
      await settleAudits();

      expect(decision.allowed).toBe(false);
      expect(auditChain.record).toHaveBeenCalledTimes(1);
      expect(recorded).toBeDefined();
      expect(actual.auditChain.loadAll().find((entry) => entry.id === recorded?.id)).toMatchObject({
        action: 'tenant.scope_violation',
        operation: 'knowledge/confidential/other-tenant/private-audit-probe.md',
        result: 'denied',
        reason: decision.reason,
        tenantSlug: 'acme-corp',
        metadata: { target_tenant: 'other-tenant' },
      });
      expect(stderr).not.toHaveBeenCalled();
    });

    it('also bounds a denial inside the group-access audit sink', async () => {
      seedSharedGroup();
      const { auditChain } = await import('./governance/audit-chain.js');
      const record = vi.mocked(auditChain.record);
      record.mockImplementation((entry) => {
        if (record.mock.calls.length < 8) validateWritePermission(nestedTarget);
        return entry as ReturnType<typeof auditChain.record>;
      });

      validateWritePermission(groupTarget);
      await settleAudits();

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        action: 'tenant.group_access',
        result: 'allowed',
        metadata: { tenant_slug: 'acme-corp', tenant_group_id: 'unit-shared' },
      });
      expect(stderr).toHaveBeenCalledTimes(1);
    });
  });

  it('denies worker access to confidential projects when project scope is missing or invalid', () => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_TENANT = 'acme-corp';
    delete process.env.KYBERION_PROJECT_ID;

    const target = path.join(
      ROOT,
      'active/projects/confidential/acme-corp/PRJ-ACME-OPS/state.json'
    );
    expect(validateReadPermission(target).allowed).toBe(false);

    process.env.KYBERION_PROJECT_ID = '../PRJ-ACME-OPS';
    expect(validateReadPermission(target).allowed).toBe(false);
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

    const { auditChain } = await import('./governance/audit-chain.js');
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

  it('bounds denied and allowed reentrancy from a broker audit without dropping independent events', async () => {
    await vi.dynamicImportSettled();
    delete process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const { auditChain } = await import('./governance/audit-chain.js');
    const record = vi.mocked(auditChain.record);
    record.mockReset();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const allowedTarget = path.join(ROOT, 'knowledge/confidential/acme-corp/broker-audit.md');
    const deniedTarget = path.join(ROOT, 'knowledge/confidential/gamma-org/broker-denied.md');
    let nestedDenied: ReturnType<typeof validateWritePermission> | undefined;
    try {
      record.mockImplementation((entry) => {
        if (record.mock.calls.length < 8) validateWritePermission(allowedTarget);
        return entry as ReturnType<typeof auditChain.record>;
      });
      validateWritePermission(allowedTarget);
      await vi.dynamicImportSettled();
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].action).toBe('tenant.broker_access');
      expect(stderr).not.toHaveBeenCalled();

      record.mockImplementation((entry) => {
        if (record.mock.calls.length < 8) {
          nestedDenied = validateWritePermission(deniedTarget);
        }
        return entry as ReturnType<typeof auditChain.record>;
      });
      validateWritePermission(allowedTarget);
      await vi.dynamicImportSettled();
      expect(record).toHaveBeenCalledTimes(2);
      expect(nestedDenied?.allowed).toBe(false);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[1][0]).toMatchObject({
        action: 'tenant.broker_access',
        result: 'allowed',
        metadata: { target_tenant: 'acme-corp', broker_tenants: ['acme-corp', 'beta-co'] },
      });
    } finally {
      record.mockReset();
      stderr.mockRestore();
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

describe('tier-guard audit module load failure', () => {
  it('reports each independent failed import attempt and keeps subsequent denials denied', async () => {
    await vi.dynamicImportSettled();
    vi.resetModules();
    vi.doMock('./governance/audit-chain.js', () => {
      throw new Error('private module load detail');
    });
    vi.stubEnv('KYBERION_TENANT', 'acme-corp');
    vi.stubEnv('KYBERION_TENANT_SCOPE_REQUIRED', '0');
    vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
    vi.stubEnv('KYBERION_SUDO', '0');
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const isolated = await import('./tier-guard.js');
      for (const tenant of ['other-tenant', 'another-tenant']) {
        const decision = isolated.validateWritePermission(
          path.join(ROOT, 'knowledge/confidential', tenant, 'secret.md')
        );
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('tenant.scope_violation');
      }
      await vi.dynamicImportSettled();
      expect(stderr).toHaveBeenCalledTimes(2);

      expect(
        isolated.validateWritePermission(
          path.join(ROOT, 'knowledge/confidential/other-tenant/later.md')
        ).allowed
      ).toBe(false);
      await vi.dynamicImportSettled();
      expect(stderr).toHaveBeenCalledTimes(3);
      for (const [line] of stderr.mock.calls) {
        expect(String(line)).toContain('Tenant access audit persistence unverified');
        expect(String(line)).not.toMatch(/private module|acme-corp|other-tenant|secret.md/);
      }
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
      vi.doMock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
      vi.resetModules();
    }
  });
});
