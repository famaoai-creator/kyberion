import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExecutionEnv,
  isRoleAssumptionAllowed,
  resetRoleAssumptionPolicyCache,
  resolveAssumedRole,
  resolveExecutionPersona,
  resolveIdentityContext,
  resolveRole,
  withExecutionContext,
  withExecutionContextAsync,
} from './authority.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import { pathResolver } from './path-resolver.js';
import { policyEngine } from './policy-engine.js';
import {
  buildSafeExecEnv,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { validateReadPermission } from './tier-guard.js';

const ENV_KEYS = ['SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA', 'MISSION_ID'] as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('RA-01 scoped role assumption', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  it('lets an assumed role outrank SYSTEM_ROLE, then falls back to SYSTEM_ROLE', () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    process.env.MISSION_ROLE = 'mission_controller';

    expect(resolveRole()).toBe('chronos_mirror_v2');
    const inside = withExecutionContext('chronos_localadmin', () => ({
      role: resolveRole(),
      identityRole: resolveIdentityContext().role,
      persona: resolveIdentityContext().persona,
    }));
    expect(inside).toEqual({
      role: 'chronos_localadmin',
      identityRole: 'chronos_localadmin',
      persona: 'worker',
    });
    expect(resolveRole()).toBe('chronos_mirror_v2');
  });

  it('keeps SYSTEM_ROLE above MISSION_ROLE when nothing is assumed', () => {
    process.env.SYSTEM_ROLE = 'slack_bridge';
    process.env.MISSION_ROLE = 'mission_controller';
    expect(resolveAssumedRole()).toBeUndefined();
    expect(resolveRole()).toBe('slack_bridge');
  });

  it('never reads the assumed role from an inherited environment variable', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    expect(resolveAssumedRole()).toBeUndefined();
    expect(resolveRole()).toBe('chronos_mirror_v2');
  });

  it('grants the assumed role its tier-guard permissions under SYSTEM_ROLE', () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    const tenantRegistryPath = 'knowledge/personal/tenants/acme.json';

    expect(validateReadPermission(tenantRegistryPath).allowed).toBe(false);
    expect(
      withExecutionContext('chronos_localadmin', () => validateReadPermission(tenantRegistryPath))
        .allowed
    ).toBe(true);
  });

  it('isolates concurrent async contexts assuming different roles', async () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    const aEntered = deferred();
    const bEntered = deferred();

    const a = withExecutionContextAsync('chronos_localadmin', async () => {
      aEntered.resolve();
      await bEntered.promise;
      // B has now overwritten the process-global env mirror.
      return { role: resolveRole(), persona: resolveExecutionPersona() };
    });
    await aEntered.promise;
    const b = withExecutionContextAsync(
      'mission_controller',
      async () => {
        bEntered.resolve();
        await new Promise((r) => setTimeout(r, 5));
        return { role: resolveRole(), persona: resolveExecutionPersona() };
      },
      'ecosystem_architect'
    );

    await expect(a).resolves.toEqual({ role: 'chronos_localadmin', persona: 'worker' });
    await expect(b).resolves.toEqual({
      role: 'mission_controller',
      persona: 'ecosystem_architect',
    });
    expect(resolveRole()).toBe('chronos_mirror_v2');
  });

  it('restores nested contexts across awaits', async () => {
    const seen: Array<string | undefined> = [];
    await withExecutionContextAsync('mission_controller', async () => {
      seen.push(resolveRole());
      await withExecutionContextAsync('surface_runtime', async () => {
        await Promise.resolve();
        seen.push(resolveRole());
        withExecutionContext('knowledge_steward', () => seen.push(resolveRole()));
        seen.push(resolveRole());
      });
      await new Promise((r) => setTimeout(r, 1));
      seen.push(resolveRole());
    });
    expect(seen).toEqual([
      'mission_controller',
      'surface_runtime',
      'knowledge_steward',
      'surface_runtime',
      'mission_controller',
    ]);
  });

  it('restores the env mirror after the context, including on throw', async () => {
    process.env.MISSION_ROLE = 'outer_role';
    process.env.KYBERION_PERSONA = 'analyst';

    expect(() =>
      withExecutionContext('mission_controller', () => {
        expect(process.env.MISSION_ROLE).toBe('mission_controller');
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(process.env.MISSION_ROLE).toBe('outer_role');
    expect(process.env.KYBERION_PERSONA).toBe('analyst');

    await withExecutionContextAsync('surface_runtime', async () => {
      await Promise.resolve();
      // B1: the async helper never mirrors into the process env.
      expect(process.env.MISSION_ROLE).toBe('outer_role');
      expect(resolveRole()).toBe('surface_runtime');
    });
    expect(process.env.MISSION_ROLE).toBe('outer_role');
    expect(process.env.KYBERION_PERSONA).toBe('analyst');
  });

  it('leaves the process env intact when async contexts interleave (B1)', async () => {
    process.env.MISSION_ROLE = 'outer_role';
    process.env.KYBERION_PERSONA = 'worker';
    const aEntered = deferred();
    const bEntered = deferred();
    const aDone = deferred();
    const seen: Record<string, unknown> = {};

    // A enters, B enters, A exits first, B exits last.
    const a = withExecutionContextAsync('knowledge_steward', async () => {
      aEntered.resolve();
      await bEntered.promise;
      seen.a = { role: resolveRole(), persona: resolveExecutionPersona() };
    });
    await aEntered.promise;
    const b = withExecutionContextAsync(
      'mission_controller',
      async () => {
        bEntered.resolve();
        await aDone.promise;
        seen.b = { role: resolveRole(), persona: resolveExecutionPersona() };
      },
      'ecosystem_architect'
    );
    await a;
    aDone.resolve();
    await b;

    expect(seen).toEqual({
      a: { role: 'knowledge_steward', persona: 'analyst' },
      b: { role: 'mission_controller', persona: 'ecosystem_architect' },
    });
    expect(process.env.MISSION_ROLE).toBe('outer_role');
    expect(process.env.KYBERION_PERSONA).toBe('worker');
    expect(resolveRole()).toBe('outer_role');
  });

  it('keeps the scoped role across awaits when the sync helper gets an async fn (S4)', async () => {
    process.env.MISSION_ROLE = 'outer_role';
    const seen = await withExecutionContext('mission_controller', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { role: resolveRole(), envRole: process.env.MISSION_ROLE };
    });
    // The scope follows the promise; the env mirror was restored when fn returned.
    expect(seen).toEqual({ role: 'mission_controller', envRole: 'outer_role' });
    expect(resolveRole()).toBe('outer_role');
  });

  it('does not restore the sync env mirror over a value fn wrote itself', () => {
    process.env.MISSION_ROLE = 'outer_role';
    withExecutionContext('mission_controller', () => {
      process.env.MISSION_ROLE = 'set_by_fn';
    });
    expect(process.env.MISSION_ROLE).toBe('set_by_fn');
  });

  it('builds a child env from the scoped assumption, not the shared env mirror', async () => {
    const release = deferred();
    const a = withExecutionContextAsync('chronos_localadmin', async () => {
      await release.promise;
      return buildExecutionEnv();
    });
    await withExecutionContextAsync(
      'mission_controller',
      async () => {
        release.resolve();
        await new Promise((r) => setTimeout(r, 5));
      },
      'ecosystem_architect'
    );
    const env = await a;
    expect(env.MISSION_ROLE).toBe('chronos_localadmin');
    expect(env.KYBERION_PERSONA).toBe('worker');
  });

  it('gives safe-exec children the scoped role, not the shared env mirror', async () => {
    const release = deferred();
    const a = withExecutionContextAsync('chronos_localadmin', async () => {
      await release.promise;
      return buildSafeExecEnv();
    });
    await withExecutionContextAsync(
      'mission_controller',
      async () => {
        release.resolve();
        await new Promise((r) => setTimeout(r, 5));
      },
      'ecosystem_architect'
    );
    const env = await a;
    expect(env.MISSION_ROLE).toBe('chronos_localadmin');
    expect(env.KYBERION_PERSONA).toBe('worker');
  });
});

describe('S6 role normalization', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('normalizes the assumed role once for the scope, the env mirror and children', () => {
    const seen = withExecutionContext(' Mission Controller ', () => ({
      role: resolveRole(),
      mirror: process.env.MISSION_ROLE,
      child: buildExecutionEnv().MISSION_ROLE,
      safeChild: buildSafeExecEnv().MISSION_ROLE,
      persona: resolveExecutionPersona(),
    }));
    expect(seen).toEqual({
      role: 'mission_controller',
      mirror: 'mission_controller',
      child: 'mission_controller',
      safeChild: 'mission_controller',
      persona: 'worker',
    });
  });
});

describe('B2 persona authorization inputs', () => {
  it('gives the secure-io policy gate the execution-scope persona', async () => {
    const saved = process.env.KYBERION_PERSONA;
    process.env.KYBERION_PERSONA = 'worker';
    const evaluate = vi.spyOn(policyEngine, 'evaluate');
    const target = pathResolver.sharedTmp(`ra-b2-${process.pid}.txt`);
    try {
      await withExecutionContextAsync(
        'mission_controller',
        async () => {
          await Promise.resolve();
          safeWriteFile(target, 'b2');
        },
        'analyst'
      );
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'file_write', agentId: 'analyst' })
      );
    } finally {
      evaluate.mockRestore();
      safeRmSync(target, { force: true });
      if (saved === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = saved;
    }
  });
});

describe('RA-02 role assumption policy', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  it('denies a role that is not listed for the SYSTEM_ROLE before running fn', () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    let ran = false;
    expect(() =>
      withExecutionContext('system_configurator', () => {
        ran = true;
      })
    ).toThrow(/\[ROLE_ASSUMPTION_DENIED\].*chronos_mirror_v2.*system_configurator/);
    expect(ran).toBe(false);
    expect(process.env.MISSION_ROLE).toBeUndefined();
  });

  it('denies from the async helper too', async () => {
    process.env.SYSTEM_ROLE = 'slack_bridge';
    await expect(withExecutionContextAsync('chronos_localadmin', async () => 1)).rejects.toThrow(
      '[ROLE_ASSUMPTION_DENIED]'
    );
  });

  it('always allows assuming the SYSTEM_ROLE itself', () => {
    process.env.SYSTEM_ROLE = 'not_listed_system_role';
    expect(withExecutionContext('not_listed_system_role', () => resolveRole())).toBe(
      'not_listed_system_role'
    );
    expect(() => withExecutionContext('mission_controller', () => undefined)).toThrow(
      '[ROLE_ASSUMPTION_DENIED]'
    );
  });

  it('allows listed and shared core roles', () => {
    expect(isRoleAssumptionAllowed('chronos_mirror_v2', 'chronos_localadmin')).toBe(true);
    expect(isRoleAssumptionAllowed('chronos_mirror_v2', 'chronos_operator')).toBe(true);
    expect(isRoleAssumptionAllowed('chronos_mirror_v2', 'mission_controller')).toBe(true);
    expect(isRoleAssumptionAllowed('concierge', 'concierge_localadmin')).toBe(true);
    expect(isRoleAssumptionAllowed('system_configurator', 'mission_controller')).toBe(true);
    expect(isRoleAssumptionAllowed('slack_bridge', 'chronos_localadmin')).toBe(false);
    expect(isRoleAssumptionAllowed('not_listed_system_role', 'chronos_gateway')).toBe(false);
    expect(isRoleAssumptionAllowed('concierge', 'chronos_localadmin')).toBe(false);
  });

  it('leaves processes without SYSTEM_ROLE unrestricted', () => {
    expect(withExecutionContext('system_configurator', () => resolveRole())).toBe(
      'system_configurator'
    );
  });
});

describe('S1 scope integrity', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  type Registry = { storage: { run<T>(scope: unknown, fn: () => T): T } };
  const rawStorage = () =>
    (globalThis as unknown as Record<symbol, Registry>)[
      Symbol.for('kyberion.core.execution-scope.v1')
    ].storage;

  it('ignores a scope run directly on the global storage with a role RA-02 rejects', () => {
    process.env.SYSTEM_ROLE = 'slack_bridge';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const seen = rawStorage().run(
        { tenantBound: false, assumedRole: 'chronos_localadmin', assumedPersona: 'sovereign' },
        () => ({
          role: resolveRole(),
          persona: resolveExecutionPersona(),
          child: buildSafeExecEnv().MISSION_ROLE,
          identity: resolveIdentityContext().role,
        })
      );
      expect(seen).toEqual({
        role: 'slack_bridge',
        persona: undefined,
        child: undefined,
        identity: 'slack_bridge',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ROLE_ASSUMPTION_IGNORED]'));
    } finally {
      warn.mockRestore();
    }
  });

  it('still honours a directly run scope whose role the policy allows', () => {
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
    const role = rawStorage().run({ tenantBound: false, assumedRole: 'chronos_localadmin' }, () =>
      resolveRole()
    );
    expect(role).toBe('chronos_localadmin');
  });

  it('freezes the scope an assumption runs in', () => {
    const frozen = withExecutionContext('mission_controller', () =>
      Object.isFrozen(currentExecutionScope())
    );
    expect(frozen).toBe(true);
  });
});

describe('RA-02 policy coverage', () => {
  it('lists every surface that surface_runtime launches with a SYSTEM_ROLE', () => {
    const policy = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/governance/role-assumption-policy.json'), {
          encoding: 'utf8',
        })
      )
    ) as { system_roles: Record<string, unknown> };
    const surfacesDir = pathResolver.knowledge('product/governance/surfaces');
    const surfaceIds = safeReaddir(surfacesDir)
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        const manifest = JSON.parse(
          String(safeReadFile(path.join(surfacesDir, entry), { encoding: 'utf8' }))
        ) as { surfaces?: Array<{ id: string }> };
        return (manifest.surfaces ?? []).map((surface) => surface.id);
      });
    expect(surfaceIds.length).toBeGreaterThan(0);
    // surface_runtime.ts: SYSTEM_ROLE = surfaceId.replace(/-/g, '_')
    const missing = surfaceIds
      .map((id) => id.replace(/-/g, '_'))
      .filter((systemRole) => !(systemRole in policy.system_roles));
    expect(missing).toEqual([]);
    // package.json `surfaces` / `config-mission` scripts.
    expect(policy.system_roles).toHaveProperty('surface_runtime');
    expect(policy.system_roles).toHaveProperty('system_configurator');
  });

  it('never shares the broad roles and justifies each per-surface grant (S2)', () => {
    const policy = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/governance/role-assumption-policy.json'), {
          encoding: 'utf8',
        })
      )
    ) as {
      shared_core_roles: { roles: string[] };
      system_roles: Record<string, { may_assume: string[]; rationale: string }>;
    };
    const broad = ['ecosystem_architect', 'mission_controller', 'sovereign_concierge'];
    expect(policy.shared_core_roles.roles.filter((role) => broad.includes(role))).toEqual([]);
    for (const [systemRole, entry] of Object.entries(policy.system_roles)) {
      for (const role of entry.may_assume.filter((candidate) => broad.includes(candidate))) {
        expect(entry.rationale, `${systemRole} must justify ${role}`).toContain(`${role}`);
      }
    }
  });
});
