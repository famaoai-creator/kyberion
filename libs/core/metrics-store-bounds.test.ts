import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeAppendFileSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { MetricsCollector } from './metrics.js';

/**
 * MSN-STORE-BOUNDS-2: the metrics/usage readers stream (no total-size cap).
 * The usage reader skips a torn or malformed line (and warns) instead of
 * losing the whole file, so usage totals never silently drop to zero.
 */
describe('metrics history readers (streamed)', () => {
  let base: string;
  let metricsDir: string;
  const collector = () =>
    new MetricsCollector({
      metricsDir,
      resourceUsageRoot: path.join(base, 'usage-ledger'),
      executionMetricsRoot: path.join(base, 'execution-metrics'),
    });

  beforeEach(() => {
    base = pathResolver.sharedTmp(`metrics-store-bounds-${randomUUID()}`);
    metricsDir = path.join(base, 'metrics');
    safeMkdir(metricsDir, { recursive: true });
  });
  afterEach(() => safeRmSync(base, { recursive: true, force: true }));

  const usageRow = (i: number) =>
    JSON.stringify({ type: 'resource_usage', usage_id: `u-${i}`, cost_usd: 0.25 });

  it('keeps usage totals across a torn tail and a malformed middle line', () => {
    const rows = Array.from({ length: 400 }, (_, i) => usageRow(i));
    rows.splice(200, 0, '{not json');
    safeWriteFile(
      path.join(metricsDir, 'resource-usage.jsonl'),
      `${rows.join('\n')}\n{"type":"resource_usage","usage_id":"torn","cost`
    );
    const records = collector().loadResourceUsageHistory();
    expect(records).toHaveLength(400);
    const total = records.reduce((sum, record) => sum + Number(record.cost_usd ?? 0), 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('loadHistory keeps its malformed-line contract (callback or fail closed)', () => {
    const file = path.join(metricsDir, 'execution-metrics.jsonl');
    safeWriteFile(file, `${JSON.stringify({ component: 'a', duration_ms: 1 })}\n`);
    safeAppendFileSync(file, '{broken\n');
    safeAppendFileSync(file, `${JSON.stringify({ component: 'b', duration_ms: 2 })}\n`);
    expect(collector().loadHistory()).toEqual([]);
    expect(() => collector().loadHistory({ strict: true })).toThrow();
    const malformed: number[] = [];
    expect(
      collector()
        .loadHistory({ strict: true, onMalformed: (line) => malformed.push(line) })
        .map((row) => row.component)
    ).toEqual(['a', 'b']);
    expect(malformed).toEqual([2]);
  });
});
