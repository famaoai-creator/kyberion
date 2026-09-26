import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildExecutionEnv,
  resolveAssumedRole,
  resolveExecutionPersona,
  resolveIdentityContext,
  resolveRole,
  withExecutionContext,
  withExecutionContextAsync,
} from './authority.js';
import { buildSafeExecEnv } from './secure-io.js';
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
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
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
      expect(process.env.MISSION_ROLE).toBe('surface_runtime');
    });
    expect(process.env.MISSION_ROLE).toBe('outer_role');
    expect(process.env.KYBERION_PERSONA).toBe('analyst');
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
