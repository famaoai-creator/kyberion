import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { appendJsonLine } from '../foundation/json.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import { DOT_OUTCOMES_FILE, dotStatePath, type DotOutcomeRow } from './dot-state-paths.js';
import {
  dotOutcomeContinuation,
  dotProgressSummary,
  dotProgressPromptSection,
  dotProgressStatusSection,
  readDotProgressOutcomes,
} from './dot-progress.js';
import {
  evaluateDotTriggersDue,
  recordDotWakeOutcome,
  DOT_WAKE_RETRY_AFTER_MS,
  DOT_WAKE_CIRCUIT_THRESHOLD,
  runDotWake,
  recordDotTokenUsage,
} from './dot-runtime.js';
import { ensureDotExtensionsRegistered } from './dot-extension-bootstrap.js';
import { evaluateDueDotOutcomes, scheduleDotOutcomeChecks } from './dot-outcomes.js';

const rootDir = `active/shared/tmp/dot-progress-${randomUUID()}`;
const now = () => new Date('2026-10-17T10:00:00Z');
const deps = { rootDir, now, opsAlert: () => {} };
const charter = {
  kind: 'dot-charter',
  dot_id: 'ops',
  status: 'active',
  version: '1.0.0',
  title: 'Ops',
  purpose: 'Observe outcomes',
  scope: { tier: 'public' },
  goal: {
    statement: 'Reduce errors',
    key_results: [
      {
        kr_id: 'errors',
        title: 'Errors',
        metric: { source: 'org_metric', metric: 'open_incidents' },
        target: 0,
        direction: 'decrease',
      },
      {
        kr_id: 'coverage',
        title: 'Coverage',
        metric: { source: 'org_metric', metric: 'open_incidents' },
        target: 100,
        direction: 'increase',
      },
    ],
  },
  attention: { triggers: [] },
  authority: { authority_role: 'infrastructure_sentinel' },
  runtime: { heartbeat_id: 'dot-ops' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
} as unknown as DotCharter;

function row(action_ref: string, over: Partial<DotOutcomeRow> = {}): DotOutcomeRow {
  return {
    dot_id: 'ops',
    action_ref,
    work_item_id: `wi-${action_ref}`,
    ref: { kr_id: 'errors' },
    before: 10,
    after: 10,
    verdict: 'no_change',
    due_at: '2026-10-17T08:00:00Z',
    measured_at: '2026-10-17T09:00:00Z',
    ...over,
  };
}
function seed(rows: unknown[], c = charter) {
  const file = path.join(rootDir, dotStatePath(c, DOT_OUTCOMES_FILE));
  safeMkdir(path.dirname(file), { recursive: true });
  for (const value of rows) appendJsonLine(file, value);
}
afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('Dot progress evidence', () => {
  it('a delayed settled outcome resumes the loop without an inbox or cron wake', async () => {
    scheduleDotOutcomeChecks(charter, {
      ...deps,
      readResults: () => [
        {
          dot_id: charter.dot_id,
          action_ref: 'settled',
          work_item_id: 'wi-settled',
          mode: 'pipeline',
          status: 'done',
          summary: 'Executed',
          started_at: '2026-10-17T07:00:00Z',
          completed_at: '2026-10-17T08:00:00Z',
          kr_snapshot: { errors: 10 },
        },
      ],
      expectedEffectOf: () => ({ kr_id: 'errors', direction: 'decrease' }),
    });
    expect(evaluateDotTriggersDue(charter, deps)).toEqual([]);
    const measured = await evaluateDueDotOutcomes(charter, {
      ...deps,
      measureKrs: async () => ({ errors: 5 }),
      recordRegression: () => {},
    });
    expect(measured).toMatchObject([{ verdict: 'improved' }]);
    const due = evaluateDotTriggersDue(charter, deps);
    expect(due).toMatchObject([{ trigger: { kind: 'outcome' } }]);
    recordDotWakeOutcome(charter, due[0], 'delivered', deps);
    expect(evaluateDotTriggersDue(charter, deps)).toEqual([]);
  });

  it('separates per-metric stalls, goal satisfaction, and missing measurement', () => {
    seed([
      row('a'),
      row('b', { ref: { kr_id: 'coverage' }, verdict: 'improved', after: 60 }),
      row('c'),
      row('d', { ref: { signal: 'health' }, verdict: 'unmeasurable' }),
    ]);
    expect(
      dotProgressSummary(charter, deps).map((p) => [p.ref, p.state, p.non_improving_streak])
    ).toEqual([
      [{ signal: 'health' }, 'measurement_needed', 0],
      [{ kr_id: 'errors' }, 'replan', 2],
      [{ kr_id: 'coverage' }, 'progressing', 0],
    ]);
    expect(
      dotProgressPromptSection()
        .lines(charter, { ...deps })
        .join('\n')
    ).toContain('Change hypothesis, tool or decomposition');
    seed([row('e', { after: 0 })]);
    expect(dotProgressSummary(charter, deps)[0].state).toBe('satisfied');
    expect(dotProgressStatusSection().collect(charter, deps)).toHaveProperty('progress');
  });

  it('resets on improvement and ignores duplicates, old, future and malformed rows', () => {
    seed([
      row('a'),
      row('b'),
      row('c', { verdict: 'improved', after: 5 }),
      row('d'),
      row('d'),
      row('a'),
      row('old', { measured_at: '2026-09-01T10:00:00Z', due_at: '2026-09-01T09:00:00Z' }),
      null,
      {},
      row('future', { measured_at: '2026-10-18T10:00:00Z' }),
      row('unsettled', { due_at: '2026-10-18T10:00:00Z' }),
      row('bad', { ref: null as never }),
      row('missing-values', { after: undefined }),
      row('other', { dot_id: 'other' }),
    ]);
    const progress = dotProgressSummary(charter, deps)[0];
    expect(progress).toMatchObject({
      state: 'observing',
      non_improving_streak: 1,
      action_ref: 'd',
    });
    expect(readDotProgressOutcomes(charter, deps).map((r) => r.action_ref)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'old',
    ]);
  });

  it('coalesces by append order; duplicate append cannot revive a consumed prefix', () => {
    expect(dotOutcomeContinuation(charter, deps)).toBeUndefined();
    seed([row('a'), row('b')]);
    const first = dotOutcomeContinuation(charter, deps)!;
    seed([row('late', { measured_at: '2026-10-17T08:30:00Z' })]);
    const late = dotOutcomeContinuation(charter, deps)!;
    expect(late.key).not.toBe(first.key);
    seed([row('b')]);
    expect(dotOutcomeContinuation(charter, deps)).toEqual(late);
    expect(late.detail).not.toContain('errors');
  });

  it('a late older measurement cannot resurrect a streak after improvement', () => {
    seed([
      row('a'),
      row('b', { measured_at: '2026-10-17T09:30:00Z', verdict: 'improved', after: 5 }),
      row('late', { measured_at: '2026-10-17T08:30:00Z' }),
    ]);
    expect(dotProgressSummary(charter, deps)[0]).toMatchObject({
      state: 'progressing',
      non_improving_streak: 0,
      action_ref: 'b',
    });
  });

  it('reconciles newly valid clock-skewed evidence even before the last appended row', () => {
    seed([row('skewed', { measured_at: '2026-10-17T11:00:00Z' }), row('b')]);
    const first = evaluateDotTriggersDue(charter, deps)[0];
    recordDotWakeOutcome(charter, first, 'delivered', deps);
    const later = { ...deps, now: () => new Date('2026-10-17T11:00:00Z') };
    const next = evaluateDotTriggersDue(charter, later);
    expect(next).toHaveLength(1);
    expect(next[0].key).not.toBe(first.key);
    recordDotWakeOutcome(charter, next[0], 'delivered', later);
    expect(evaluateDotTriggersDue(charter, later)).toEqual([]);
  });

  it('survives restart and preserves a new outcome arriving while a wake runs', () => {
    seed([row('a'), row('b')]);
    const first = evaluateDotTriggersDue(charter, deps);
    expect(first).toHaveLength(1);
    expect(first[0].trigger.kind).toBe('outcome');
    // Appended after the old wake took its watermark, before it records delivery.
    seed([row('c')]);
    recordDotWakeOutcome(charter, first[0], 'delivered', deps);
    const next = evaluateDotTriggersDue(charter, { ...deps });
    expect(next).toHaveLength(1);
    expect(next[0].key).not.toBe(first[0].key);
    recordDotWakeOutcome(charter, next[0], 'delivered', deps);
    expect(evaluateDotTriggersDue(charter, { ...deps })).toEqual([]);
    seed([row('a')]);
    expect(evaluateDotTriggersDue(charter, deps)).toEqual([]);
  });

  it('uses normal wake failure backoff and dot-wide circuit protection', () => {
    seed([row('a')]);
    const trigger = evaluateDotTriggersDue(charter, deps)[0];
    recordDotWakeOutcome(charter, trigger, 'failed', { ...deps, reason: 'provider unavailable' });
    expect(evaluateDotTriggersDue(charter, deps)).toEqual([]);
    const later = { ...deps, now: () => new Date(now().getTime() + DOT_WAKE_RETRY_AFTER_MS) };
    expect(evaluateDotTriggersDue(charter, later)).toHaveLength(1);
    for (let i = 1; i < DOT_WAKE_CIRCUIT_THRESHOLD; i++) {
      recordDotWakeOutcome(charter, trigger, 'failed', { ...deps, reason: 'provider unavailable' });
    }
    // A new key must not bypass the dot-wide circuit.
    seed([row('b')]);
    expect(evaluateDotTriggersDue(charter, deps)).toEqual([]);
  });

  it('an outcome wake still checks budget and current authority before invoking a provider', async () => {
    // A cron declaration keeps this schema-valid without matching the test time.
    const c: DotCharter = {
      ...charter,
      attention: { triggers: [{ kind: 'cron', cron: '0 1 * * *', timezone: 'UTC' }] },
      goal: { ...charter.goal, budget: { token_cap_per_day: 10 } },
    };
    const file = `${rootDir}/dots/ops.json`;
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, JSON.stringify(c));
    seed([row('a'), row('b')]);
    const trigger = evaluateDotTriggersDue(c, deps)[0];
    recordDotTokenUsage(c.dot_id, 10, deps);
    let called = false;
    const runLoop = async () => {
      called = true;
      return { turnsRun: 1, goal: {} };
    };
    const result = await runDotWake(
      { path: file, charter: c },
      {
        ...deps,
        trigger,
        hasRole: () => true,
        runLoop,
      }
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(called).toBe(false);
    expect(evaluateDotTriggersDue(c, deps)).toHaveLength(1);
    const revoked = await runDotWake(
      { path: file, charter: c },
      {
        ...deps,
        trigger,
        hasRole: () => false,
        runLoop,
      }
    );
    expect(revoked.outcome).toBe('failed');
    expect(called).toBe(false);

    // After the daily budget resets, normal wake execution sees the progress extension.
    ensureDotExtensionsRegistered();
    const tomorrow = { ...deps, now: () => new Date(now().getTime() + 24 * 60 * 60 * 1000) };
    const delivered = await runDotWake(
      { path: file, charter: c },
      {
        ...tomorrow,
        trigger,
        hasRole: () => true,
        backend: { generateWithTools: async () => ({ text: '' }) },
        runLoop: async (options) => {
          expect(options.systemPrompt).toContain('Change hypothesis, tool or decomposition');
          return { turnsRun: 1, goal: { budgetStats: { tokensUsed: 1 } } };
        },
      }
    );
    expect(delivered.outcome).toBe('delivered');
    expect(evaluateDotTriggersDue(c, tomorrow)).toEqual([]);
  });

  it('separates tenant lookup and continuation identities even for equal dot/action IDs', () => {
    const a = { ...charter, scope: { tier: 'confidential', tenant_slug: 'acme' } } as DotCharter;
    const b = { ...charter, scope: { tier: 'confidential', tenant_slug: 'beta' } } as DotCharter;
    seed([row('same')], a);
    expect(dotOutcomeContinuation(b, deps)).toBeUndefined();
    seed([row('same')], b);
    expect(dotOutcomeContinuation(a, deps)?.key).not.toBe(dotOutcomeContinuation(b, deps)?.key);
    expect(dotProgressSummary(charter, deps)).toEqual([]);
  });
});
