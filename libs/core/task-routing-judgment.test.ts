import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import {
  exportRoutingCorpus,
  exportRoutingCorpusAcrossMissions,
  nextTaskModelTier,
  routeTaskWithJudgment,
  TASK_TIER_DESCRIPTIONS,
  TASK_TIER_QUESTION,
  taskTierQuestion,
  type RoutingOutcome,
} from './task-routing-judgment.js';
import type { TaskModelHint } from './reasoning-model-routing.js';

const BASELINE: TaskModelHint = {
  tier: 'large',
  effort: 'high',
  model_id: 'big-model',
  route_reason: 'phase_kind=implement',
};

function provider(value: string, confidence = 0.95): JudgmentBackend {
  return {
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: (question) => question.id === TASK_TIER_QUESTION,
    async judge(request) {
      return request.questions.map((question) => ({
        id: question.id,
        value,
        confidence,
        calibrated: false,
      }));
    },
  };
}

const base = { task: 'rename the variable `foo` to `bar` in one file', baseline: BASELINE };

afterEach(() => {
  resetJudgmentBackends();
});

describe('routeTaskWithJudgment', () => {
  it('narrows the tier when a provider is confident', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('small'));
    const result = await routeTaskWithJudgment(base);
    expect(result.hint.tier).toBe('small');
    expect(result.source).toBe('judgment');
    expect(result.downgradedFrom).toBe('large');
    expect(result.hint.model_id).toBe('big-model');
  });

  it('acts without a fit by default, unlike the other call sites', async () => {
    // A wrong answer here costs a visible retry, and the retry is the label
    // that makes calibration possible — so this site is not inert.
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('small'));
    const result = await routeTaskWithJudgment(base);
    expect(result.source).toBe('judgment');
  });

  it('stays inert when the caller says its dispatch cannot escalate', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('small'));
    const result = await routeTaskWithJudgment({ ...base, requireCalibrated: true });
    expect(result.hint.tier).toBe('large');
    expect(result.reason).toMatch(/not calibrated/);
  });

  it('refuses to raise the tier, however confident', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('large'));
    const result = await routeTaskWithJudgment({
      ...base,
      baseline: { ...BASELINE, tier: 'standard' },
    });
    // Escalation belongs to dispatch, which knows the task actually failed.
    expect(result.hint.tier).toBe('standard');
    expect(result.source).toBe('baseline');
  });

  it('refuses to go below the floor tier', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('small'));
    const result = await routeTaskWithJudgment({ ...base, floorTier: 'standard' });
    expect(result.hint.tier).toBe('large');
    expect(result.source).toBe('baseline');
  });

  it('does not ask at all when the baseline is already at the floor', async () => {
    registerOrganizationWorkJudgment();
    let asked = false;
    registerJudgmentBackend({
      ...provider('small'),
      async judge(request) {
        asked = true;
        return request.questions.map((q) => ({
          id: q.id,
          value: 'small',
          confidence: 0.95,
          calibrated: false,
        }));
      },
    });
    const result = await routeTaskWithJudgment({
      ...base,
      baseline: { ...BASELINE, tier: 'small' },
    });
    expect(asked).toBe(false);
    expect(result.reason).toMatch(/at or below the floor/);
  });

  it('keeps the baseline when unsure, when unavailable, and when the provider throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('small', 0.3));
    expect((await routeTaskWithJudgment(base)).hint.tier).toBe('large');

    resetJudgmentBackends();
    expect((await routeTaskWithJudgment(base)).hint.tier).toBe('large');

    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('small'),
      async judge() {
        throw new Error('worker exploded');
      },
    });
    expect((await routeTaskWithJudgment(base)).hint.tier).toBe('large');
  });

  it('never sends task text to an external provider by default', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('small'),
      judgment_id: 'typesafe-jev',
      egress: 'external-api',
    });
    expect((await routeTaskWithJudgment(base)).hint.tier).toBe('large');
  });

  it('uses the caller tier when deciding whether an external provider may judge', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('small'),
      judgment_id: 'typesafe-jev',
      egress: 'external-api',
    });
    const result = await routeTaskWithJudgment({ ...base, tier: 'public' });
    expect(result.source).toBe('judgment');
    expect(result.hint.tier).toBe('small');
  });

  it('describes every tier it offers', () => {
    const question = taskTierQuestion();
    if (question.kind !== 'choice') throw new Error('expected a choice');
    expect(question.options).toEqual(['small', 'standard', 'large']);
    for (const option of question.options) {
      expect(question.optionDescriptions?.[option]).toBe(
        TASK_TIER_DESCRIPTIONS[option as keyof typeof TASK_TIER_DESCRIPTIONS]
      );
    }
  });
});

describe('retry escalation', () => {
  it('moves one tier at a time and stops at large', () => {
    expect(nextTaskModelTier('small')).toBe('standard');
    expect(nextTaskModelTier('standard')).toBe('large');
    expect(nextTaskModelTier('large')).toBeUndefined();
  });
});

describe('exportRoutingCorpus', () => {
  /** `recordRoutingOutcome` is a no-op under vitest, so build the shape here. */
  const ledger: RoutingOutcome[] = [
    {
      task_excerpt: 'rename a variable',
      baseline_tier: 'standard',
      chosen_tier: 'small',
      chosen_by: 'judgment',
      succeeded: true,
      recorded_at: '2026-09-21T00:00:00.000Z',
    },
    {
      task_excerpt: 'design the caching layer',
      baseline_tier: 'standard',
      chosen_tier: 'small',
      chosen_by: 'judgment',
      succeeded: false,
      escalated_to: 'large',
      recorded_at: '2026-09-21T00:01:00.000Z',
    },
  ];

  it('labels a task with the smallest tier observed to finish it', () => {
    // The retry is the label: small failed, large finished, so large is what
    // a correct router would have picked.
    const collapse = (rows: RoutingOutcome[]) => {
      const order = ['small', 'standard', 'large'];
      const byTask = new Map<string, RoutingOutcome[]>();
      for (const row of rows) {
        byTask.set(row.task_excerpt, [...(byTask.get(row.task_excerpt) || []), row]);
      }
      return [...byTask].map(([task, group]) => {
        const won = group
          .map((row) => (row.succeeded ? row.chosen_tier : row.escalated_to))
          .filter(Boolean) as string[];
        return {
          task,
          expected: won.reduce((best, t) => (order.indexOf(t) < order.indexOf(best) ? t : best)),
        };
      });
    };
    expect(collapse(ledger)).toEqual([
      { task: 'rename a variable', expected: 'small' },
      { task: 'design the caching layer', expected: 'large' },
    ]);
  });

  it('returns an empty corpus rather than throwing when nothing has been recorded', () => {
    expect(Array.isArray(exportRoutingCorpus())).toBe(true);
  });

  it('aggregates only the explicitly supplied mission-local ledgers', () => {
    const missionA = pathResolver.sharedTmp(`routing-corpus-a-${process.pid}`);
    const missionB = pathResolver.sharedTmp(`routing-corpus-b-${process.pid}`);
    try {
      safeMkdir(`${missionA}/evidence`, { recursive: true });
      safeMkdir(`${missionB}/evidence`, { recursive: true });
      safeWriteFile(
        `${missionA}/evidence/routing-outcomes.jsonl`,
        `${JSON.stringify(ledger[0])}\n`
      );
      safeWriteFile(
        `${missionB}/evidence/routing-outcomes.jsonl`,
        `${JSON.stringify(ledger[1])}\n`
      );

      expect(exportRoutingCorpusAcrossMissions([missionA, missionB])).toEqual([
        {
          task_excerpt: 'rename a variable',
          expected_tier: 'small',
          observations: 1,
        },
        {
          task_excerpt: 'design the caching layer',
          expected_tier: 'large',
          observations: 1,
        },
      ]);
    } finally {
      safeRmSync(missionA, { recursive: true, force: true });
      safeRmSync(missionB, { recursive: true, force: true });
    }
  });

  it('does not label a task when repeated attempts all fail', () => {
    const mission = pathResolver.sharedTmp(`routing-corpus-failures-${process.pid}`);
    const failedSmall: RoutingOutcome = {
      task_excerpt: 'task with repeated failures',
      baseline_tier: 'large',
      chosen_tier: 'small',
      chosen_by: 'judgment',
      succeeded: false,
      recorded_at: '2026-09-21T00:02:00.000Z',
    };
    const failedStandard: RoutingOutcome = {
      ...failedSmall,
      chosen_tier: 'standard',
      recorded_at: '2026-09-21T00:03:00.000Z',
    };
    try {
      safeMkdir(`${mission}/evidence`, { recursive: true });
      safeWriteFile(
        `${mission}/evidence/routing-outcomes.jsonl`,
        `${JSON.stringify(failedSmall)}\n${JSON.stringify(failedStandard)}\n`
      );

      expect(exportRoutingCorpusAcrossMissions([mission])).toEqual([]);
    } finally {
      safeRmSync(mission, { recursive: true, force: true });
    }
  });
});
