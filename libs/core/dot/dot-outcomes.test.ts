import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendJsonLine } from '../foundation/json.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_OUTCOME_MAX_WAIT_MS,
  dotOutcomeStats,
  dotOutcomeVerdict,
  dotOutcomesPromptLines,
  evaluateDueDotOutcomes,
  readDotOutcomes,
  scheduleDotOutcomeChecks,
  type DotOutcomeDeps,
} from './dot-outcomes.js';
import { DOT_SIGNAL_LEDGER_PATH } from './dot-feedback.js';
import { DOT_WORK_RESULTS_FILE, dotStatePath, type DotWorkResultRow } from './dot-state-paths.js';

const TEST_ROOT = `active/shared/tmp/dot-outcomes-tests-${randomUUID()}`;
const T0 = new Date('2026-10-04T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function charter(overrides: Partial<DotCharter['goal']> = {}): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'ops',
    version: '1.0.0',
    title: 'Ops',
    purpose: 'p',
    status: 'active',
    scope: { tier: 'public' },
    goal: {
      statement: 'g',
      key_results: [
        {
          kr_id: 'errors',
          title: 'e',
          metric: { source: 'org_metric', metric: 'open_incidents' },
          target: 0,
          direction: 'decrease',
        },
        {
          kr_id: 'cov',
          title: 'c',
          metric: { source: 'org_metric', metric: 'open_incidents' },
          target: 100,
          direction: 'increase',
          settle_minutes: 10,
        },
      ],
      ...overrides,
    },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
    authority: { authority_role: 'infrastructure_sentinel' },
  } as unknown as DotCharter;
}

function result(ref: string, over: Partial<DotWorkResultRow> = {}): DotWorkResultRow {
  return {
    dot_id: 'ops',
    work_item_id: `wi-${ref}`,
    action_ref: ref,
    mode: 'goal_turn',
    status: 'done',
    summary: 's',
    started_at: T0.toISOString(),
    completed_at: T0.toISOString(),
    kr_snapshot: { errors: 10, cov: 50 },
    ...over,
  };
}

function seed(c: DotCharter, rows: DotWorkResultRow[]) {
  const f = path.join(TEST_ROOT, dotStatePath(c, DOT_WORK_RESULTS_FILE));
  safeMkdir(path.dirname(f), { recursive: true });
  for (const r of rows) appendJsonLine(f, r);
}

const base = (now: Date, over: Partial<DotOutcomeDeps> = {}): DotOutcomeDeps => ({
  rootDir: TEST_ROOT,
  now: () => now,
  expectedEffectOf: () => undefined,
  recordRegression: vi.fn(),
  ...over,
});

afterEach(() => safeRmSync(TEST_ROOT, { recursive: true, force: true }));

describe('dot outcomes', () => {
  it('verdict is direction-aware with tolerance', () => {
    expect(dotOutcomeVerdict('decrease', 10, 5, 0, 0.1)).toBe('improved');
    expect(dotOutcomeVerdict('decrease', 5, 10, 0, 0.1)).toBe('regressed');
    expect(dotOutcomeVerdict('increase', 5, 5.05, 100, 1)).toBe('no_change');
    expect(dotOutcomeVerdict('maintain', 90, 99, 100, 1)).toBe('improved');
    expect(dotOutcomeVerdict('increase', 1, NaN, 100, 1)).toBe('unmeasurable');
  });

  it('schedules done results once with settle precedence', () => {
    const c = charter({ outcome_settle_minutes: 30 });
    seed(c, [result('a1'), result('a2', { status: 'failed' }), result('a3')]);
    const deps = base(T0, {
      expectedEffectOf: (id) =>
        id === 'wi-a3' ? { kr_id: 'cov', direction: 'increase' } : undefined,
    });
    const first = scheduleDotOutcomeChecks(c, deps);
    expect(first.map((p) => [p.action_ref, p.due_at])).toEqual([
      ['a1', at(30).toISOString()],
      ['a3', at(10).toISOString()],
    ]);
    expect(scheduleDotOutcomeChecks(c, deps)).toEqual([]);
  });

  it('defaults settle to 60 minutes', () => {
    const c = charter();
    seed(c, [result('a1')]);
    expect(scheduleDotOutcomeChecks(c, base(T0))[0].due_at).toBe(at(60).toISOString());
  });

  it('evaluates only due checks, once, and records regressions', async () => {
    const c = charter();
    seed(c, [result('a1'), result('a2', { kr_snapshot: { errors: 2, cov: 50 } })]);
    const deps = base(at(60), { measureKrs: async () => ({ errors: 4, cov: 50 }) });
    scheduleDotOutcomeChecks(c, deps);
    const early = await evaluateDueDotOutcomes(c, base(at(5), { measureKrs: async () => ({}) }));
    expect(early).toEqual([]);
    const rows = await evaluateDueDotOutcomes(c, deps);
    const byRef = Object.fromEntries(rows.map((r) => [r.action_ref, r]));
    expect(byRef.a1).toMatchObject({
      verdict: 'improved',
      ref: { kr_id: 'errors' },
      before: 10,
      after: 4,
    });
    expect(byRef.a2).toMatchObject({ verdict: 'regressed', ref: { kr_id: 'errors' } });
    expect(deps.recordRegression).toHaveBeenCalledTimes(1);
    expect(await evaluateDueDotOutcomes(c, deps)).toEqual([]);
    expect(readDotOutcomes(c, { rootDir: TEST_ROOT, limit: 1 })).toHaveLength(1);
    expect(dotOutcomeStats(c, { rootDir: TEST_ROOT, now: () => at(60), sinceDays: 1 })).toEqual({
      improved: 1,
      no_change: 0,
      regressed: 1,
      unmeasurable: 0,
      success_rate: 0.5,
    });
    expect(dotOutcomesPromptLines(c, { rootDir: TEST_ROOT, now: () => at(60) }).length).toBe(3);
  });

  it('expected_effect direction overrides the KR direction', async () => {
    const c = charter();
    seed(c, [result('a1')]);
    const deps = base(at(60), {
      expectedEffectOf: () => ({ kr_id: 'errors', direction: 'increase' }),
      measureKrs: async () => ({ errors: 4 }),
    });
    scheduleDotOutcomeChecks(c, deps);
    expect((await evaluateDueDotOutcomes(c, deps))[0].verdict).toBe('regressed');
  });

  it('signal effects judge the claim-time snapshot against a later measurement', async () => {
    const c = charter();
    seed(c, [
      result('s1', { signal_snapshot: { api: 0 } }),
      result('s2', { signal_snapshot: { api: 0 } }),
      // No pre-action snapshot: measuring "before" now would see the action's own effect.
      result('s4'),
    ]);
    const deps = base(at(60), {
      expectedEffectOf: () => ({ signal: 'api', direction: 'increase' }),
      // The action already fixed the signal by the time outcomes are scheduled.
      measureSignal: () => 1,
      measureKrs: async () => ({}),
    });
    const scheduled = scheduleDotOutcomeChecks(c, deps);
    expect(scheduled.map((p) => p.signal_before)).toEqual([0, 0, undefined]);
    const rows = await evaluateDueDotOutcomes(c, deps);
    const byRef = Object.fromEntries(rows.map((r) => [r.action_ref, r.verdict]));
    expect(byRef).toEqual({ s1: 'improved', s2: 'improved', s4: 'unmeasurable' });

    const c2 = charter();
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    seed(c2, [result('s3', { kr_snapshot: undefined })]);
    const d2 = base(at(60), { measureKrs: async () => ({ errors: 1 }) });
    scheduleDotOutcomeChecks(c2, d2);
    expect((await evaluateDueDotOutcomes(c2, d2))[0].verdict).toBe('unmeasurable');
  });

  it('never schedules read-only delegated results', () => {
    const c = charter();
    seed(c, [result('d1', { mode: 'delegated' }), result('g1')]);
    expect(scheduleDotOutcomeChecks(c, base(T0)).map((p) => p.action_ref)).toEqual(['g1']);
  });

  it('keeps a check pending until a measurement after completion, then expires it', async () => {
    const c = charter({ outcome_settle_minutes: 0 });
    seed(c, [result('a1', { completed_at: at(30).toISOString() })]);
    const ledger = path.join(TEST_ROOT, DOT_SIGNAL_LEDGER_PATH);
    safeMkdir(path.dirname(ledger), { recursive: true });
    // Only a measurement taken before the action completed exists.
    appendJsonLine(ledger, {
      dot_id: 'ops',
      signal: 'api',
      healthy: true,
      measured_at: at(20).toISOString(),
    });
    const deps = (now: Date) =>
      base(now, {
        expectedEffectOf: () => ({ signal: 'api', direction: 'increase' }),
        readResults: () => [
          result('a1', { completed_at: at(30).toISOString(), signal_snapshot: { api: 0 } }),
        ],
      });
    scheduleDotOutcomeChecks(c, deps(at(30)));
    // No measurement after completed_at -> no verdict yet.
    const stale = await evaluateDueDotOutcomes(c, deps(at(40)));
    expect(stale).toEqual([]);
    // Past the max wait with still no fresh measurement -> unmeasurable, once.
    const late = at(30 + DOT_OUTCOME_MAX_WAIT_MS / 60_000 + 1);
    const expired = await evaluateDueDotOutcomes(c, deps(late));
    expect(expired).toEqual([
      expect.objectContaining({
        action_ref: 'a1',
        verdict: 'unmeasurable',
        ref: { signal: 'api' },
      }),
    ]);
    expect(await evaluateDueDotOutcomes(c, deps(late))).toEqual([]);
  });

  it('a failed KR re-measure retries instead of closing the check', async () => {
    const c = charter();
    seed(c, [result('a1')]);
    scheduleDotOutcomeChecks(c, base(T0));
    const failing = base(at(60), {
      measureKrs: async () => {
        throw new Error('metric source down');
      },
    });
    expect(await evaluateDueDotOutcomes(c, failing)).toEqual([]);
    const recovered = await evaluateDueDotOutcomes(
      c,
      base(at(70), { measureKrs: async () => ({ errors: 4, cov: 50 }) })
    );
    expect(recovered).toEqual([expect.objectContaining({ action_ref: 'a1', verdict: 'improved' })]);
  });
});
