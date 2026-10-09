import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeRmSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

// Capture the metrics logger's warn lines; tier-guard and secure-io stay REAL.
const warnLines = vi.hoisted(() => [] as string[]);
vi.mock('./logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger.js')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      if (name !== 'metrics') return real;
      return { ...real, warn: (message: string) => warnLines.push(String(message)) };
    },
  };
});

import * as metricsModule from './metrics.js';
import {
  EXECUTION_METRICS_LEDGER_ROOT,
  MetricsCollector,
  RESOURCE_USAGE_LEDGER_ROOT,
  metrics,
} from './metrics.js';
import * as spendGuard from './spend-guard.js';
import { computeBudgetUsage } from './governance/org-budget-governor.js';
import { buildCostReportFromHistory, formatCostReport } from './cost-report.js';
import { validateReadPermission } from './tier-guard.js';
import { withExecutionContext } from './authority.js';

/**
 * R4 follow-up: cap enforcers count every tier of their scope whatever the
 * caller's persona (governed numbers-only aggregate), and reports built from a
 * persona-gated read say they are partial. Ledger roots are the real logical,
 * tenant-protected roots so the real tier-guard decides; secure-io maps the
 * bytes into the Vitest live sandbox. The shared `metrics` collector is pointed
 * at that collector, as the production enforcers read through it.
 */
const ROOT = pathResolver.rootDir();
const TENANT = `capg-${process.pid}`;
const MISSION = `MSN-CAPG-${process.pid}`;
const TASK_TEXT = 'secret task text for the confidential customer';
const base = path.join(ROOT, 'active/shared/tmp/metrics-enforcement-aggregate-test');
const metricsDir = path.join(base, 'metrics');
const usageRoot = path.join(ROOT, RESOURCE_USAGE_LEDGER_ROOT);
const executionRoot = path.join(ROOT, EXECUTION_METRICS_LEDGER_ROOT);
const collector = new MetricsCollector({
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

/** $2 of confidential spend for this tenant's mission, written by an allowed writer. */
function seedConfidentialSpend(): void {
  setIdentity('worker', 'mission_controller');
  const scope = { tier: 'confidential' as const, tenant_slug: TENANT };
  for (const cost of [1.5, 0.5]) {
    collector.record('anthropic-sdk', 1, 'success', {
      mission_id: MISSION,
      cost_usd: cost,
      task: TASK_TEXT,
      scope,
    });
  }
  collector.recordResourceUsage({
    usage_id: `usage-${TENANT}`,
    resource_kind: 'llm',
    mission_id: MISSION,
    quantity: 1,
    unit: 'call',
    cost_usd: 3,
    status: 'actual',
    source: 'enforcement-test',
    scope,
  });
}

describe('governed enforcement aggregate over persona-gated metrics ledgers', () => {
  beforeEach(() => {
    warnLines.length = 0;
    delete process.env.KYBERION_TENANT;
    delete process.env.MISSION_ID;
    cleanup();
    safeMkdir(metricsDir, { recursive: true });
    seedConfidentialSpend();
    vi.spyOn(metrics, 'loadHistory').mockImplementation((options) =>
      collector.loadHistory(options)
    );
    vi.spyOn(metrics, 'loadResourceUsageHistory').mockImplementation((read, options) =>
      collector.loadResourceUsageHistory(read, options)
    );
    (spendGuard as { resetSpendGuardCache?: () => void }).resetSpendGuardCache?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("counts a worker's own confidential spend toward its cap and blocks at the cap", () => {
    setIdentity('worker');
    // The persona still may not read the rows themselves.
    expect(collector.loadHistory({ read: { all: true } })).toEqual([]);
    const alert = vi.fn();
    const result = spendGuard.checkSpendGuard({
      now: Date.now(),
      missionId: MISSION,
      policy: { posture: 'block', daily_cap_usd: 1, mission_cap_usd: 1.5 },
      alert: alert as never,
    });
    expect(result.daily_spent_usd).toBe(2);
    expect(result.mission_spent_usd).toBe(2);
    expect(result.breached).toEqual(['daily', 'mission']);
    expect(result.allowed).toBe(false);
  });

  it("counts a worker's own confidential spend in its tenant budget", () => {
    setIdentity('worker');
    const usage = computeBudgetUsage(
      { tenant_slug: TENANT },
      { listCharters: () => [], readDotTokenUsage: () => [] }
    );
    expect(usage.cost_usd).toBe(2);
  });

  it('returns numbers only — no rows, ids, scopes or text', () => {
    setIdentity('worker');
    const aggregate = (metricsModule as Record<string, unknown>).aggregateMetricsForEnforcement as
      typeof metricsModule.aggregateMetricsForEnforcement | undefined;
    expect(typeof aggregate).toBe('function');
    const totals = aggregate!({
      enforcer: 'spend_guard',
      ledger: 'execution_metrics',
      read: { all: true },
      measures: ['cost', 'calls'] as const,
      accumulate: (row, add) => {
        add('cost', Number(row.cost_usd) || 0);
        add('calls', 1);
      },
      collector,
    });
    expect(totals.measures).toEqual({ cost: 2, calls: 2 });
    const serialized = JSON.stringify(totals);
    for (const leak of [MISSION, TENANT, TASK_TEXT, 'anthropic-sdk', 'confidential', 'scope']) {
      expect(serialized).not.toContain(leak);
    }
    const leaves = (value: unknown): unknown[] =>
      value && typeof value === 'object'
        ? Object.values(value as Record<string, unknown>).flatMap(leaves)
        : [value];
    expect(leaves(totals).every((leaf) => typeof leaf === 'number')).toBe(true);
    // Measure names are fixed before any row is read.
    expect(() =>
      aggregate!({
        enforcer: 'spend_guard',
        ledger: 'execution_metrics',
        read: { all: true },
        measures: ['cost'] as const,
        accumulate: (row, add) => add(String(row.mission_id) as 'cost', 1),
        collector,
      })
    ).toThrow(/METRICS_ENFORCEMENT_MEASURE/);
  });

  it('elevates to a reader role that grants the ledgers only, never knowledge/', () => {
    setIdentity('worker');
    const ledgerFile = path.join(executionRoot, 'confidential', TENANT, 'execution-metrics.jsonl');
    expect(validateReadPermission(ledgerFile).allowed).toBe(false);
    withExecutionContext(metricsModule.METRICS_CAP_READER_ROLE, () => {
      expect(validateReadPermission(ledgerFile).allowed).toBe(true);
      expect(validateReadPermission(path.join(ROOT, 'knowledge/confidential')).allowed).toBe(false);
      expect(validateReadPermission(path.join(ROOT, 'knowledge/personal')).allowed).toBe(false);
    });
    // Tenant binding still applies under the role.
    process.env.KYBERION_TENANT = 'other-tenant';
    withExecutionContext(metricsModule.METRICS_CAP_READER_ROLE, () => {
      expect(validateReadPermission(ledgerFile).allowed).toBe(false);
    });
  });

  it('marks the cost report partial for a denied persona, with one diagnostic warn line', () => {
    setIdentity('worker');
    const partial = buildCostReportFromHistory();
    expect(partial.total_usd).toBe(0);
    expect(partial.withheld_partitions).toBe(2);
    expect(partial.partial_notice).toMatch(/2 metrics partition\(s\) withheld for this persona/);
    expect(formatCostReport(partial)[1]).toMatch(/^PARTIAL: 2 metrics partition\(s\) withheld/);
    const warns = warnLines.filter((line) => line.startsWith('cost report:'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^cost report: .+ withheld .+ \| next: .+ \| evidence: .+/);

    warnLines.length = 0;
    setIdentity('ecosystem_architect');
    const full = buildCostReportFromHistory();
    expect(full.total_usd).toBe(5);
    expect(full.partial_notice).toBeUndefined();
    expect(formatCostReport(full).some((line) => line.startsWith('PARTIAL'))).toBe(false);
    expect(warnLines.filter((line) => line.startsWith('cost report:'))).toEqual([]);
  });
});
