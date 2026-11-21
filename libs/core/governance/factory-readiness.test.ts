import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';
import { evaluateFactoryReadiness } from './factory-readiness.js';
import type { MandateCatalog } from './mandate-shadow.js';

const testCatalog: MandateCatalog = {
  version: '1.0',
  external_effect_patterns: [],
  mandates: [
    {
      id: 'docs-update',
      title: 'Docs update',
      work_type_patterns: ['docs'],
      allowed_path_globs: ['docs/**'],
      max_risk_level: 1,
      expires_at: '2027-01-01T00:00:00.000Z',
    },
  ],
};

describe('factory-readiness', () => {
  let scratchDir: string;
  let haltFilePath: string;

  beforeEach(() => {
    scratchDir = pathResolver.sharedTmp(`factory-readiness-test-${randomUUID()}`);
    safeMkdir(scratchDir, { recursive: true });
    haltFilePath = path.join(scratchDir, 'operations-halt.json');
  });

  afterEach(() => {
    if (scratchDir) safeRmSync(scratchDir, { recursive: true, force: true });
  });

  it('reports not ready by default when no tenant has opted in', () => {
    const report = evaluateFactoryReadiness({
      tenant_slug: 'acme',
      mandate_catalog: testCatalog,
      halt_file_path: haltFilePath,
      now: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(report.ready).toBe(false);
    expect(report.tenant_enabled).toBe(false);
    expect(report.graduated_actions).toEqual([]);
    expect(report.blockers.join(' ')).toContain('not opted in');
  });

  it('reports ready when tenant is opted in, actions are graduated, mandates are active, and operations are not halted', () => {
    const policy: FactoryAutonomyPolicy = {
      version: '1.0.0',
      tenants: {
        acme: {
          enabled: true,
          graduated_actions: ['mission_start_mandate', 'ci_autofix_attempt'],
        },
      },
    };
    const report = evaluateFactoryReadiness({
      tenant_slug: 'acme',
      factory_policy: policy,
      mandate_catalog: testCatalog,
      halt_file_path: haltFilePath,
      now: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(report.ready).toBe(true);
    expect(report.halted).toBe(false);
    expect(report.tenant_enabled).toBe(true);
    expect(report.graduated_actions).toEqual(['mission_start_mandate', 'ci_autofix_attempt']);
    expect(report.active_mandate_count).toBe(1);
    expect(report.blockers).toEqual([]);
    const startAction = report.actions.find((a) => a.action_id === 'mission_start_mandate');
    expect(startAction?.graduated).toBe(true);
    expect(startAction?.shadow).toBe(false);
    expect(startAction?.allowed).toBe(true);
  });

  it('reports halted, expired mandates, and invalid tenant slugs as blockers', () => {
    const policy: FactoryAutonomyPolicy = {
      version: '1.0.0',
      tenants: {
        acme: {
          enabled: true,
          graduated_actions: ['mission_start_mandate'],
        },
      },
    };
    safeWriteFile(
      haltFilePath,
      JSON.stringify({ halted: true, by: 'operator', reason: 'maintenance' })
    );
    const haltedReport = evaluateFactoryReadiness({
      tenant_slug: 'acme',
      factory_policy: policy,
      mandate_catalog: {
        version: '1.0',
        external_effect_patterns: [],
        mandates: [
          {
            ...testCatalog.mandates[0],
            expires_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      halt_file_path: haltFilePath,
      now: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(haltedReport.ready).toBe(false);
    expect(haltedReport.halted).toBe(true);
    expect(haltedReport.active_mandate_count).toBe(0);
    expect(haltedReport.blockers.join(' ')).toContain('halted');
    expect(haltedReport.blockers.join(' ')).toContain('standing mandates');

    const invalidTenantReport = evaluateFactoryReadiness({
      tenant_slug: 'public',
      factory_policy: policy,
      mandate_catalog: testCatalog,
      halt_file_path: path.join(scratchDir, 'other-halt.json'),
      now: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(invalidTenantReport.ready).toBe(false);
    expect(invalidTenantReport.blockers.join(' ')).toContain('Invalid tenant_slug');
  });
});
