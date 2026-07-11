import { describe, expect, it } from 'vitest';
import {
  buildCostReport,
  effectiveCostUsd,
  formatCostReport,
  type CostLedgerEntry,
} from './cost-report.js';

const D1 = '2026-07-10T10:00:00.000Z';
const D2 = '2026-07-11T10:00:00.000Z';

function entry(overrides: Partial<CostLedgerEntry>): CostLedgerEntry {
  return { timestamp: D2, model: 'claude-fable-5', ...overrides };
}

describe('effectiveCostUsd (source priority, Task 2.2)', () => {
  it('prefers the SDK real total over the token-derived figure', () => {
    expect(effectiveCostUsd({ sdk_cost_usd: 0.5, cost_usd: 0.3 })).toBe(0.5);
    expect(effectiveCostUsd({ cost_usd: 0.3 })).toBe(0.3);
    expect(effectiveCostUsd({})).toBe(0);
    expect(effectiveCostUsd({ sdk_cost_usd: Number.NaN, cost_usd: 0.2 })).toBe(0.2);
  });
});

describe('buildCostReport', () => {
  const entries: CostLedgerEntry[] = [
    entry({
      mission_id: 'MSN-A',
      cost_usd: 0.2,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    entry({ mission_id: 'MSN-A', sdk_cost_usd: 0.6, cost_usd: 0.1 }),
    entry({ mission_id: 'MSN-B', model: 'gemini-3.5-flash', cost_usd: 0.05, estimated: true }),
    entry({ timestamp: D1, cost_usd: 0.4 }),
    entry({ cost_usd: 0 }), // zero cost — excluded
    entry({ timestamp: 'garbage', cost_usd: 9 }), // unparsable timestamp — excluded
  ];

  it('aggregates by mission, model, and day with source priority applied', () => {
    const report = buildCostReport(entries);
    expect(report.total_usd).toBeCloseTo(1.25, 5);
    expect(report.estimated_usd).toBeCloseTo(0.05, 5);
    expect(report.calls).toBe(4);

    const missionA = report.by_mission.find((b) => b.key === 'MSN-A');
    expect(missionA?.cost_usd).toBeCloseTo(0.8, 5); // 0.2 + 0.6 (sdk wins over 0.1)
    expect(missionA?.prompt_tokens).toBe(100);

    const noMission = report.by_mission.find((b) => b.key === '(no mission)');
    expect(noMission?.cost_usd).toBeCloseTo(0.4, 5);

    expect(report.by_day.map((b) => b.key)).toEqual(['2026-07-10', '2026-07-11']);
  });

  it('applies the since window', () => {
    const report = buildCostReport(entries, { since: '2026-07-11T00:00:00.000Z' });
    expect(report.total_usd).toBeCloseTo(0.85, 5);
    expect(report.by_day.map((b) => b.key)).toEqual(['2026-07-11']);
  });

  it('formats a readable summary with the estimated share', () => {
    const lines = formatCostReport(buildCostReport(entries));
    expect(lines[0]).toContain('$1.2500');
    expect(lines[0]).toContain('estimated');
    expect(lines.join('\n')).toContain('MSN-A');
  });
});
