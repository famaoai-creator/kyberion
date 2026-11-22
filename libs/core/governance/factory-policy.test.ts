import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  _resetFactoryAutonomyPolicyCacheForTests,
  FACTORY_AUTONOMY_POLICY_REL,
  FACTORY_GRADUATABLE_ACTIONS,
  getFactoryAutonomyPolicy,
  getTenantFactoryAutonomyConfig,
  isFactoryActionGraduated,
  loadFactoryAutonomyPolicy,
  mergeTenantFactoryAutonomyOverlays,
  type FactoryAutonomyPolicy,
} from './factory-policy.js';

describe('factory-policy', () => {
  let scratchDir: string;

  beforeEach(() => {
    _resetFactoryAutonomyPolicyCacheForTests();
    scratchDir = pathResolver.sharedTmp(`factory-policy-test-${randomUUID()}`);
    safeMkdir(scratchDir, { recursive: true });
  });

  afterEach(() => {
    _resetFactoryAutonomyPolicyCacheForTests();
    if (scratchDir) safeRmSync(scratchDir, { recursive: true, force: true });
  });

  it('ships with zero tenants graduated by default', () => {
    const productOnly = getFactoryAutonomyPolicy({ tenantOverlays: false });
    expect(productOnly.tenants).toEqual({});
    const policy = getFactoryAutonomyPolicy();
    for (const actionId of FACTORY_GRADUATABLE_ACTIONS) {
      expect(isFactoryActionGraduated(actionId, 'acme', productOnly)).toBe(false);
      expect(isFactoryActionGraduated(actionId, 'acme', policy)).toBe(false);
    }
  });

  it('graduates only explicitly enabled tenants and graduatable actions', () => {
    const policyPath = path.join(scratchDir, 'factory-autonomy-policy.json');
    safeWriteFile(
      policyPath,
      JSON.stringify(
        {
          $schema: '../schemas/factory-autonomy-policy.schema.json',
          version: '1.0.0',
          tenants: {
            acme: {
              enabled: true,
              graduated_actions: ['mission_start_mandate', 'ci_autofix_attempt'],
              max_parallel_missions: 2,
              default_branch_prefix: 'agent/factory-',
              approved_by: 'operator:alice',
              approved_at: '2026-11-21T00:00:00.000Z',
            },
            paused: {
              enabled: false,
              graduated_actions: ['mission_start_mandate'],
            },
          },
        },
        null,
        2
      )
    );

    const loaded = loadFactoryAutonomyPolicy({ policyPath });
    expect(getTenantFactoryAutonomyConfig('acme', loaded)?.enabled).toBe(true);
    expect(isFactoryActionGraduated('mission_start_mandate', 'acme', loaded)).toBe(true);
    expect(isFactoryActionGraduated('ci_autofix_attempt', 'acme', loaded)).toBe(true);
    expect(isFactoryActionGraduated('pr_merge_low', 'acme', loaded)).toBe(false);
    expect(isFactoryActionGraduated('pr_merge_high', 'acme', loaded)).toBe(false);
    expect(isFactoryActionGraduated('mission_start_mandate', 'paused', loaded)).toBe(false);
    expect(isFactoryActionGraduated('mission_start_mandate', 'unknown', loaded)).toBe(false);
  });

  it('rejects non-graduatable actions, invalid tenant slugs, and prototype keys', () => {
    const forged: FactoryAutonomyPolicy = {
      version: '1.0.0',
      tenants: {
        acme: {
          enabled: true,
          graduated_actions: ['mission_start_mandate'],
        },
      },
    };
    expect(isFactoryActionGraduated('pr_merge_high', 'acme', forged)).toBe(false);
    expect(isFactoryActionGraduated('conflict_semantic', 'acme', forged)).toBe(false);
    expect(isFactoryActionGraduated('mission_start_mandate', 'public', forged)).toBe(false);
    expect(isFactoryActionGraduated('mission_start_mandate', '__proto__', forged)).toBe(false);
    expect(isFactoryActionGraduated('mission_start_mandate', undefined, forged)).toBe(false);
    expect(getTenantFactoryAutonomyConfig('__proto__', forged)).toBeUndefined();
    expect(getTenantFactoryAutonomyConfig('BAD_SLUG', forged)).toBeUndefined();
  });

  it('fails closed when rootDir has no policy file, and throws on corrupt/external policyPath', () => {
    const empty = loadFactoryAutonomyPolicy({ rootDir: scratchDir });
    expect(empty.tenants).toEqual({});

    const badRootPolicy = path.join(scratchDir, FACTORY_AUTONOMY_POLICY_REL);
    safeMkdir(path.dirname(badRootPolicy), { recursive: true });
    safeWriteFile(badRootPolicy, '{not-json');
    expect(() => loadFactoryAutonomyPolicy({ rootDir: scratchDir })).toThrow();

    const invalidSchemaPath = path.join(scratchDir, 'invalid.json');
    safeWriteFile(
      invalidSchemaPath,
      JSON.stringify({
        version: '1.0.0',
        tenants: {
          acme: {
            enabled: true,
            graduated_actions: ['pr_merge_high'],
          },
        },
      })
    );
    expect(() => loadFactoryAutonomyPolicy({ policyPath: invalidSchemaPath })).toThrow(
      /Invalid catalog/
    );

    expect(() =>
      loadFactoryAutonomyPolicy({ policyPath: '/tmp/outside-repo-factory-policy.json' })
    ).toThrow();
  });

  it('merges confidential tenant governance overlays strictly scoped to each tenant', () => {
    const base: FactoryAutonomyPolicy = { version: '1.0.0', tenants: {} };
    const merged = mergeTenantFactoryAutonomyOverlays(base, [
      {
        tenant_slug: 'acme',
        path: 'knowledge/confidential/acme/governance/factory-autonomy-policy.json',
        value: {
          version: '1.0.0',
          tenants: {
            acme: {
              enabled: true,
              graduated_actions: ['ci_autofix_attempt', 'pr_merge_low'],
            },
            beta: {
              enabled: true,
              graduated_actions: ['pr_merge_medium'],
            },
          },
        },
      },
      {
        tenant_slug: 'broken',
        path: 'knowledge/confidential/broken/governance/factory-autonomy-policy.json',
        value: {
          version: '1.0.0',
          tenants: {
            broken: {
              enabled: true,
              graduated_actions: ['pr_merge_high'],
            },
          },
        },
      },
    ]);
    expect(isFactoryActionGraduated('ci_autofix_attempt', 'acme', merged)).toBe(true);
    expect(isFactoryActionGraduated('pr_merge_low', 'acme', merged)).toBe(true);
    expect(isFactoryActionGraduated('pr_merge_medium', 'beta', merged)).toBe(false);
    expect(getTenantFactoryAutonomyConfig('broken', merged)).toBeUndefined();

    // End-to-end filesystem load with registered tenant profile + confidential overlay under rootDir.
    safeMkdir(path.join(scratchDir, 'knowledge/personal/tenants'), { recursive: true });
    safeWriteFile(
      path.join(scratchDir, 'knowledge/personal/tenants/acme.json'),
      JSON.stringify(
        {
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        },
        null,
        2
      )
    );
    safeMkdir(path.join(scratchDir, 'knowledge/confidential/acme/governance'), {
      recursive: true,
    });
    safeWriteFile(
      path.join(scratchDir, 'knowledge/confidential/acme/governance/factory-autonomy-policy.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          tenants: {
            acme: {
              enabled: true,
              graduated_actions: ['ci_autofix_attempt', 'pr_merge_low'],
            },
            beta: {
              enabled: true,
              graduated_actions: ['mission_start_mandate'],
            },
          },
        },
        null,
        2
      )
    );

    const loaded = loadFactoryAutonomyPolicy({ rootDir: scratchDir });
    expect(isFactoryActionGraduated('ci_autofix_attempt', 'acme', loaded)).toBe(true);
    expect(isFactoryActionGraduated('pr_merge_low', 'acme', loaded)).toBe(true);
    expect(getTenantFactoryAutonomyConfig('beta', loaded)).toBeUndefined();
    expect(
      loadFactoryAutonomyPolicy({ rootDir: scratchDir, tenantOverlays: false }).tenants
    ).toEqual({});
  });
});
