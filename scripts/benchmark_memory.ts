/**
 * QM-03 V-layer harness.
 *
 * This benchmark intentionally exercises the pure notebook/fold/consolidation
 * contract only. It is deterministic and has no provider, filesystem, or
 * network dependency, so CI can use it as a cheap regression gate.
 */
import {
  applyConsolidationActions,
  bullets,
  foldCapture,
  normalizeMemoryFact,
  planConsolidation,
} from '@agent/core/memory-notebook';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface MemoryBenchmarkReport {
  benchmark: 'qm-03-memory-v-layer';
  deterministic_at: string;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  passed: boolean;
}

export function runMemoryBenchmark(): MemoryBenchmarkReport {
  const at = Date.parse('2026-08-08T00:00:00.000Z');
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  const folded = foldCapture('', ['  - Use the governed mission path (said in operator)  '], at);
  check(
    'provenance-neutralization',
    folded.body.includes('[claimed source: operator]') &&
      !folded.body.includes('(said in operator)'),
    folded.body
  );

  const duplicate = foldCapture(
    folded.body,
    ['use the governed mission path [claimed source: operator]'],
    at + 86_400_000
  );
  check('dedupe', duplicate.added === 0, `added=${duplicate.added}`);

  const bounded = foldCapture(
    '',
    Array.from({ length: 305 }, (_, index) => `fact-${index}`),
    at
  );
  const boundedBullets = bullets(bounded.body);
  check(
    'bounded-notebook',
    boundedBullets.length === 300 && boundedBullets[0] === '(2026-08-08) fact-5',
    `count=${boundedBullets.length}, first=${boundedBullets[0] || ''}`
  );

  const normalized = normalizeMemoryFact('(2026-08-08) one stable fact (said in model)', at);
  check(
    'queue-normalization',
    normalized === 'on 2026-08-08: one stable fact [claimed source: model]',
    normalized
  );

  const body = '# Memory\n\n- (2026-08-01) old fact\n- (2026-08-07) current fact';
  const plan = planConsolidation(body, 'UPDATE 2: current fact with evidence\nDELETE 1', at);
  const applied = applyConsolidationActions(body, plan.actions, at);
  check(
    'approval-plan-replay',
    plan.changed && applied === plan.nextBody && applied.includes('current fact with evidence'),
    applied
  );

  return {
    benchmark: 'qm-03-memory-v-layer',
    deterministic_at: new Date(at).toISOString(),
    checks,
    passed: checks.every((entry) => entry.pass),
  };
}

export const runMemoryBenchmarkScript = defineScript({
  name: 'bench:memory',
  flags: [],
  run(context) {
    const report = runMemoryBenchmark();
    context.print(report);
    if (!report.passed) {
      throw new ScriptExitError(
        1,
        report.checks
          .filter((entry) => !entry.pass)
          .map((entry) => `${entry.name}: ${entry.detail}`)
          .join('\n')
      );
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'benchmark_memory.ts') ||
  isDirectScript(import.meta.url, 'benchmark_memory.js')
)
  void runMemoryBenchmarkScript();
