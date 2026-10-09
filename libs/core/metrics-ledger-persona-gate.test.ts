import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeAppendFileSync, safeMkdir, safeRmSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

// Capture the metrics logger's debug lines; tier-guard and secure-io stay REAL.
const debugLines = vi.hoisted(() => [] as string[]);
vi.mock('./logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger.js')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      if (name !== 'metrics') return real;
      return { ...real, debug: (message: string) => debugLines.push(String(message)) };
    },
  };
});

import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { withExecutionContext } from './authority.js';
import {
  EXECUTION_METRICS_LEDGER_ROOT,
  MetricsCollector,
  RESOURCE_USAGE_LEDGER_ROOT,
} from './metrics.js';

/**
 * W3: personal/confidential partitions of both metrics ledgers follow
 * tier-guard's persona read rules for knowledge/<tier>/. Partition roots are
 * the real, tenant-protected logical roots, so the real tier-guard decides;
 * secure-io maps the bytes into the Vitest live sandbox.
 */
const ROOT = pathResolver.rootDir();
const TENANT = `pgate-${process.pid}`;
const base = path.join(ROOT, 'active/shared/tmp/metrics-ledger-persona-gate-test');
const metricsDir = path.join(base, 'metrics');
const usageRoot = path.join(ROOT, RESOURCE_USAGE_LEDGER_ROOT);
const executionRoot = path.join(ROOT, EXECUTION_METRICS_LEDGER_ROOT);
const collector = () =>
  new MetricsCollector({
    metricsDir,
    resourceUsageRoot: usageRoot,
    executionMetricsRoot: executionRoot,
    costRegistry: { models: {}, aliases: {}, default: { prompt: 0, completion: 0 } },
  });
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'KYBERION_TENANT', 'MISSION_ID'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setIdentity(persona: string, role?: string): void {
  process.env.KYBERION_PERSONA = persona;
  if (role) process.env.MISSION_ROLE = role;
  else delete process.env.MISSION_ROLE;
}

function cleanup(): void {
  setIdentity('worker', 'mission_controller');
  safeRmSync(base, { recursive: true, force: true });
  for (const root of [usageRoot, executionRoot]) {
    for (const tier of ['personal', 'confidential']) {
      safeRmSync(path.join(root, tier, TENANT), { recursive: true, force: true });
    }
  }
}

/** Seed one row per tier in both ledgers (partition + a legacy confidential row). */
function seed(): void {
  setIdentity('worker', 'mission_controller');
  const mc = collector();
  for (const tier of ['public', 'confidential', 'personal'] as const) {
    const scope = tier === 'public' ? { tier } : { tier, tenant_slug: TENANT };
    mc.record(`exec-${tier}`, 1, 'success', { scope });
    mc.recordResourceUsage({
      usage_id: `usage-${tier}`,
      resource_kind: 'other',
      quantity: 0,
      unit: 'task',
      status: 'estimated',
      source: 'persona-gate-test',
      scope,
    });
  }
  const legacyScope = { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT };
  safeAppendFileSync(
    path.join(metricsDir, 'execution-metrics.jsonl'),
    `${JSON.stringify({ component: 'exec-legacy-confidential', scope: legacyScope })}\n`
  );
  safeAppendFileSync(
    path.join(metricsDir, 'resource-usage.jsonl'),
    `${JSON.stringify({ type: 'resource_usage', usage_id: 'usage-legacy-confidential', scope: legacyScope })}\n`
  );
}

const execSeen = () =>
  collector()
    .loadHistory({ read: { all: true } })
    .map((row) => String(row.component))
    .sort();
const usageSeen = () =>
  collector()
    .loadResourceUsageHistory({ all: true })
    .map((row) => row.usage_id)
    .sort();

describe('metrics ledgers follow the knowledge-tier persona read rules (real tier-guard)', () => {
  beforeEach(() => {
    debugLines.length = 0;
    delete process.env.KYBERION_TENANT;
    delete process.env.MISSION_ID;
    cleanup();
    safeMkdir(metricsDir, { recursive: true });
    seed();
  });

  afterEach(() => cleanup());

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('checks the logical ledger path, not the Vitest sandbox copy', () => {
    // secure-io remaps the bytes under Vitest; tier-guard must still see the
    // logical, tenant-protected path or every assertion here is vacuous.
    expect(path.relative(ROOT, executionRoot)).toBe(EXECUTION_METRICS_LEDGER_ROOT);
    expect(path.relative(ROOT, usageRoot)).toBe(RESOURCE_USAGE_LEDGER_ROOT);
    expect(pathResolver.shared('runtime/execution-metrics')).toContain('vitest-live');
    // A tenant-bound writer may not write another tenant's partition (logical path).
    process.env.KYBERION_TENANT = 'other-tenant';
    expect(
      validateWritePermission(
        path.join(executionRoot, 'confidential', TENANT, 'execution-metrics.jsonl')
      ).allowed
    ).toBe(false);
    delete process.env.KYBERION_TENANT;
  });

  it('lets a tenant-scoped role read its own tenant partition, never another tenant', () => {
    setIdentity('worker');
    const own = path.join(executionRoot, 'confidential', TENANT, 'execution-metrics.jsonl');
    expect(validateReadPermission(own).allowed).toBe(false);
    withExecutionContext(
      'chronos_tenant_runner',
      () => {
        expect(validateReadPermission(own).allowed).toBe(true);
        expect(
          validateReadPermission(
            path.join(usageRoot, 'confidential', TENANT, 'resource-usage.jsonl')
          ).allowed
        ).toBe(true);
        expect(
          validateReadPermission(
            path.join(executionRoot, 'confidential', 'other-tenant', 'execution-metrics.jsonl')
          ).allowed
        ).toBe(false);
        // A { scope } read without a tenant is stamped with the bound tenant, as writers are.
        expect(
          collector()
            .loadHistory({ read: { scope: { tier: 'confidential' } } })
            .map((row) => String(row.component))
            .sort()
        ).toEqual(['exec-confidential', 'exec-legacy-confidential']);
      },
      undefined,
      TENANT
    );
  });

  it('decides each partition path exactly like knowledge/<tier>/<tenant>/', () => {
    const cases = [
      { persona: 'worker', role: undefined },
      { persona: 'worker', role: 'mission_controller' },
      { persona: 'ecosystem_architect', role: undefined },
      { persona: 'analyst', role: undefined },
    ];
    for (const { persona, role } of cases) {
      setIdentity(persona, role);
      for (const tier of ['personal', 'confidential']) {
        const knowledge = validateReadPermission(
          path.join(ROOT, `knowledge/${tier}/${TENANT}`)
        ).allowed;
        for (const [root, file] of [
          [RESOURCE_USAGE_LEDGER_ROOT, 'resource-usage.jsonl'],
          [EXECUTION_METRICS_LEDGER_ROOT, 'execution-metrics.jsonl'],
        ]) {
          const partition = validateReadPermission(
            path.join(ROOT, root, tier, TENANT, file)
          ).allowed;
          expect({ persona, role, tier, root, allowed: partition }).toEqual({
            persona,
            role,
            tier,
            root,
            allowed: knowledge,
          });
        }
      }
    }
    // The cases above include both outcomes.
    setIdentity('worker');
    expect(validateReadPermission(path.join(ROOT, 'knowledge/confidential')).allowed).toBe(false);
    setIdentity('ecosystem_architect');
    expect(validateReadPermission(path.join(ROOT, 'knowledge/confidential')).allowed).toBe(true);
  });

  it('lets an allowed persona read every tier of both ledgers', () => {
    setIdentity('ecosystem_architect');
    expect(execSeen()).toEqual([
      'exec-confidential',
      'exec-legacy-confidential',
      'exec-personal',
      'exec-public',
    ]);
    expect(usageSeen()).toEqual([
      'usage-confidential',
      'usage-legacy-confidential',
      'usage-personal',
      'usage-public',
    ]);
    setIdentity('worker', 'mission_controller');
    expect(execSeen()).toHaveLength(4);
    expect(usageSeen()).toHaveLength(4);
  });

  it('skips (never fails) the tiers a denied persona may not read, with a diagnostic debug line', () => {
    setIdentity('worker');
    expect(execSeen()).toEqual(['exec-public']);
    expect(usageSeen()).toEqual(['usage-public']);
    // Scoped reads of the denied partition come back empty, not as errors.
    const scope = { scope: { tier: 'confidential', tenant_slug: TENANT } };
    expect(collector().loadHistory({ read: scope })).toEqual([]);
    expect(collector().loadResourceUsageHistory(scope)).toEqual([]);
    expect(collector().loadHistory({ strict: true, read: { all: true } })).toHaveLength(1);

    for (const label of ['execution metrics', 'resource usage']) {
      const lines = debugLines.filter((line) => line.startsWith(`${label} `));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(
          new RegExp(`^${label} (partition|legacy rows) skipped — .+ \\| next: .+ \\| evidence: .+`)
        );
      }
    }
  });
});
