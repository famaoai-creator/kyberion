import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from './secure-io.js';
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
import { logger as coreLogger } from './core.js';
import { runDegradationWatch } from './health-degradation.js';
import { resolveFinanceControllerDecision } from './finance-controller.js';

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
const TENANT_B = `capb-${process.pid}`;
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
  // Stands in for the shared ledgers the enforcers read (metrics.loadHistory is
  // pointed at it below), so its costed appends update the spend cache.
  sharedLedger: true,
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
      // `shared` holds this suite's fail-closed rows (the logical root maps to
      // this worker's Vitest sandbox).
      for (const tenant of [TENANT, TENANT_B, 'shared']) {
        safeRmSync(path.join(root, tier, tenant), { recursive: true, force: true });
      }
    }
  }
}

/** Confidential spend of one tenant, written by an allowed, unbound writer. */
function seedSpend(tenant: string, cost: number): void {
  setIdentity('worker', 'mission_controller');
  collector.record('anthropic-sdk', 1, 'success', {
    mission_id: `${MISSION}-${tenant}`,
    cost_usd: cost,
    scope: { tier: 'confidential', tenant_slug: tenant },
  });
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

  describe('review fixes', () => {
    const policy = { posture: 'block' as const, daily_cap_usd: 5, mission_cap_usd: 100 };
    const check = (extra: { tenantId?: string } = {}) =>
      spendGuard.checkSpendGuard({
        now: NOW_FIXED,
        policy,
        alert: vi.fn() as never,
        ...extra,
      });
    const NOW_FIXED = Date.now();

    it('B1: never serves one bound tenant the cached spend of another', () => {
      seedSpend(TENANT_B, 7);
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      const a = check();
      expect(a.daily_spent_usd).toBe(2);
      expect(a.allowed).toBe(true);
      process.env.KYBERION_TENANT = TENANT_B;
      const b = check();
      expect(b.daily_spent_usd).toBe(7);
      expect(b.allowed).toBe(false);
    });

    it('M1: a bound process ignores another requested tenant (e.g. brokered) — never refuses', () => {
      seedSpend(TENANT_B, 7);
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      const debug = vi.spyOn(coreLogger, 'debug');
      const result = check({ tenantId: TENANT_B });
      expect(result).not.toHaveProperty('refused');
      expect(result.allowed).toBe(true);
      // The bound tenant's ledgers and caps apply, not the requested tenant's.
      expect(result.daily_spent_usd).toBe(2);
      expect(debug.mock.calls.map(String).join('\n')).toMatch(
        /requested tenant ignored — .+ \| next: .+ \| evidence: requested=/
      );
    });

    it('M1: warn posture never blocks, whatever tenant is requested', () => {
      seedSpend(TENANT_B, 7);
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      const warn = spendGuard.checkSpendGuard({
        now: NOW_FIXED,
        policy: { posture: 'warn', daily_cap_usd: 1, mission_cap_usd: 1 },
        tenantId: TENANT_B,
        alert: vi.fn() as never,
      });
      expect(warn.breached).toEqual(['daily']);
      expect(warn.allowed).toBe(true);
    });

    it('M1: a requested tenant differing only in case is the bound tenant', () => {
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      const debug = vi.spyOn(coreLogger, 'debug');
      const result = check({ tenantId: ` ${TENANT.toUpperCase()} ` });
      expect(result.daily_spent_usd).toBe(2);
      expect(debug.mock.calls.map(String).join('\n')).not.toMatch(/requested tenant ignored/);
    });

    it("L3: an unbound caller's requested tenant is read and capped as that tenant", () => {
      seedSpend(TENANT_B, 7);
      setIdentity('worker');
      delete process.env.KYBERION_TENANT;
      const a = check({ tenantId: TENANT });
      expect(a.daily_spent_usd).toBe(2);
      expect(a.allowed).toBe(true);
      const b = check({ tenantId: TENANT_B });
      expect(b.daily_spent_usd).toBe(7);
      expect(b.allowed).toBe(false);
      // Unbound without a requested tenant: the global caps over every ledger.
      expect(check().daily_spent_usd).toBe(9);
    });

    it('M2: zero-cost bursts hit the cache; a costed append is added without a re-read', () => {
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      expect(check().daily_spent_usd).toBe(2);
      const reads = spendGuard.spendGuardLedgerReads();
      setIdentity('worker', 'mission_controller');
      for (let i = 0; i < 20; i++) {
        collector.record('reasoning:route-served', 0, 'success', {
          scope: { tier: 'confidential', tenant_slug: TENANT },
        });
      }
      setIdentity('worker');
      expect(check().daily_spent_usd).toBe(2);
      expect(spendGuard.spendGuardLedgerReads()).toBe(reads);
      setIdentity('worker', 'mission_controller');
      collector.record('anthropic-sdk', 1, 'success', {
        mission_id: MISSION,
        cost_usd: 4,
        scope: { tier: 'confidential', tenant_slug: TENANT },
      });
      // Another tenant's costed row never reaches this tenant's cached total.
      collector.record('anthropic-sdk', 1, 'success', {
        cost_usd: 50,
        scope: { tier: 'confidential', tenant_slug: TENANT_B },
      });
      setIdentity('worker');
      const after = check();
      expect(after.daily_spent_usd).toBe(6);
      expect(after.allowed).toBe(false);
      expect(spendGuard.spendGuardLedgerReads()).toBe(reads);
    });

    it('B2: a budget wider than the bound tenant is reported partial, never complete', () => {
      seedSpend(TENANT_B, 7);
      setIdentity('worker');
      process.env.KYBERION_TENANT = TENANT;
      const deps = { listCharters: () => [], readDotTokenUsage: () => [] };
      const global = computeBudgetUsage({}, deps);
      expect(global.withheld_partitions).toBeGreaterThan(0);
      expect(global.cost_status).toBe('partial');
      const own = computeBudgetUsage({ tenant_slug: TENANT }, deps);
      expect(own.withheld_partitions).toBeUndefined();
      expect(own.cost_status).toBeUndefined();
      expect(own.cost_usd).toBe(2);
    });

    it('S1: the classifier sees a whitelisted projection; enforcers are allowlisted', () => {
      setIdentity('worker');
      const seen: string[] = [];
      metricsModule.aggregateMetricsForEnforcement({
        enforcer: 'spend_guard',
        ledger: 'execution_metrics',
        read: { all: true },
        measures: [],
        accumulate: (row) => {
          expect('task' in row).toBe(false);
          expect('component' in row).toBe(false);
          seen.push(JSON.stringify(row));
        },
        collector,
      });
      expect(seen).toHaveLength(2);
      expect(seen.join('\n')).not.toContain(TASK_TEXT);
      expect(() =>
        metricsModule.aggregateMetricsForEnforcement({
          enforcer: 'report_reader' as never,
          ledger: 'execution_metrics',
          read: { all: true },
          measures: [],
          accumulate: () => undefined,
          collector,
        })
      ).toThrow(/METRICS_ENFORCEMENT_ENFORCER/);
    });

    it('S4: a row whose scope cannot be placed is still counted, never downgraded', () => {
      setIdentity('worker', 'mission_controller');
      collector.record('odd-tier', 1, 'success', {
        cost_usd: 1,
        task: TASK_TEXT,
        scope: { tier: 'internal', tenant_slug: 'Not A Slug Either' },
      });
      // L1: only the tier is bad — the row keeps its valid tenant (offboarding finds it).
      collector.record('odd-tier-own-tenant', 1, 'success', {
        cost_usd: 1,
        scope: { tier: 'internal', tenant_slug: TENANT },
      });
      collector.record('odd-public', 1, 'success', {
        cost_usd: 1,
        scope: { tier: 'public', tenant_slug: 'Not A Slug' },
      });
      const read = (file: string) =>
        safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
      // Unknown tier fails closed to confidential/<bound|shared>, never the system file.
      const system = read(path.join(metricsDir, 'execution-metrics.jsonl'));
      expect(system).not.toContain('odd-tier');
      const failClosed = read(
        path.join(executionRoot, 'confidential', 'shared', 'execution-metrics.jsonl')
      );
      expect(failClosed).toContain('odd-tier');
      expect(JSON.parse(failClosed.trim().split('\n').pop() ?? '{}')).toMatchObject({
        scope: { tier: 'confidential' },
        scope_invalid: true,
      });
      // A public row with an invalid tenant is a system row without the tenant.
      const odd = system
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.component === 'odd-public');
      expect(odd).toMatchObject({ scope_invalid: true, cost_usd: 1 });
      expect(odd).not.toHaveProperty('scope');
      const ownTenant = read(
        path.join(executionRoot, 'confidential', TENANT, 'execution-metrics.jsonl')
      );
      expect(ownTenant).toContain('odd-tier-own-tenant');
      expect(failClosed).not.toContain('odd-tier-own-tenant');
      expect(warnLines.filter((line) => /scope cannot be placed/.test(line))).toHaveLength(3);
      // All are still counted by an enforcer.
      setIdentity('worker');
      expect(check().daily_spent_usd).toBe(5);
    });

    it('S7: the degradation watch and finance controller treat withheld partitions as partial', () => {
      vi.spyOn(metrics, 'detectRegressions').mockImplementation((_m, _r, options) => {
        options?.onWithheld?.(2);
        return [];
      });
      const { report } = runDegradationWatch({
        demotedProviders: [],
        runtimeSamples: [],
        alert: vi.fn() as never,
      });
      expect(report.partial_notice).toMatch(/2 metrics partition\(s\) withheld/);
      const decision = resolveFinanceControllerDecision({
        financial: { periods: [] } as never,
        okr: { objectives: [] } as never,
        costReport: {
          totalCostUsd: 1,
          totalTokens: 10,
          promptTokens: 5,
          completionTokens: 5,
          sourcePath: null,
          withheldPartitions: 3,
        },
      });
      expect(decision.reasons.join('\n')).toMatch(/partial \(3 metrics partition/);
    });
  });
});
