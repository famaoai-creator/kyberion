import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  findMissionPath: vi.fn(),
  loadState: vi.fn(),
  listApprovalRequests: vi.fn(),
}));

vi.mock('./operational-learning.js', () => ({
  enqueueOperationalLearningSignal: mocks.enqueue,
}));
vi.mock('./path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./path-resolver.js')>();
  return { ...actual, findMissionPath: mocks.findMissionPath };
});
vi.mock('./mission-state.js', () => ({ loadState: mocks.loadState }));
vi.mock('./approval-store.js', () => ({ listApprovalRequests: mocks.listApprovalRequests }));

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { compileSchema } from './foundation/ajv.js';
import {
  createWorkInventoryEntry,
  listWorkInventoryEntries,
  saveWorkInventoryEntry,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from './work-inventory.js';
import type { DemandSignal } from './work-inventory-harvest.js';
import { loadWorkInventoryCalibration } from './work-inventory-scoring.js';
import {
  applyWorkInventoryPromotion,
  buildCalibrationSamples,
  detectWorkInventoryLearningSignals,
  emitWorkInventoryLearningSignals,
  executeMissionPromotion,
  measureWorkInventoryOutcome,
  planWorkInventoryPromotion,
  recordWorkInventoryOutcome,
  runWorkInventoryLearningCycle,
  workInventoryMissionId,
  WorkInventoryPromotionError,
  type WorkInventoryMissionPromotionPlan,
  type WorkInventoryPromotionExec,
} from './work-inventory-promotion.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const LATER = new Date('2026-10-20T12:00:00.000Z');
const HUMAN = { kind: 'human' as const, id: 'user:alice' };

function step(overrides: Partial<WorkInventoryStep>): WorkInventoryStep {
  return {
    step_id: 'S1',
    stage: 'act',
    verb: 'transform',
    description: 'convert the export',
    data_sensitivity: 'internal',
    effects: [],
    method: {
      assigned: 'program',
      source: 'rule',
      rule_id: 'transform-to-program',
      rationale: 'r',
    },
    ...overrides,
  };
}

function baseEntry(overrides: Partial<WorkInventoryEntry> = {}): WorkInventoryEntry {
  return {
    ...createWorkInventoryEntry(
      {
        title: 'Weekly sales report',
        scope: {},
        trigger: { kind: 'schedule', description: 'every Monday morning' },
        frequency: { per: 'week', count: 1 },
        effort_minutes_per_run: 30,
        steps: [
          step({ step_id: 'S1', verb: 'transform', stage: 'act' }),
          step({
            step_id: 'S2',
            verb: 'read',
            stage: 'understand',
            description: 'summarize the numbers',
            method: {
              assigned: 'ai_reasoning',
              source: 'rule',
              rule_id: 'reasoning-verbs',
              rationale: 'r',
            },
          }),
          step({
            step_id: 'S3',
            verb: 'judge',
            stage: 'decide',
            description: 'approve the report',
            effects: ['approval'],
            requires_review: true,
            method: {
              assigned: 'human',
              source: 'rule',
              rule_id: 'effects-force-human',
              rationale: 'r',
            },
          }),
        ],
      },
      NOW
    ),
    status: 'candidate',
    ...overrides,
  };
}

function signal(overrides: Partial<DemandSignal>): DemandSignal {
  return {
    signature: 'pipeline:weekly-sales-report',
    kind: 'pipeline',
    count: 4,
    first_at: '2026-09-25T00:00:00.000Z',
    last_at: '2026-10-19T00:00:00.000Z',
    per_week: 1,
    failure_count: 1,
    window_days: 28,
    sample_refs: [],
    origin: 'on_demand',
    ...overrides,
  };
}

function promotedPipelineEntry(overrides: Partial<WorkInventoryEntry> = {}): WorkInventoryEntry {
  const entry = baseEntry(overrides);
  const plan = planWorkInventoryPromotion(
    {
      ...entry,
      steps: entry.steps.map((s, index) =>
        index === 0 ? { ...s, binding: { pipeline_id: 'weekly-sales-report' } } : s
      ),
    },
    { kind: 'pipeline', decided_by: HUMAN, now: NOW }
  );
  return applyWorkInventoryPromotion(entry, plan, { ref: 'weekly-sales-report', now: NOW });
}

describe('planWorkInventoryPromotion', () => {
  it('refuses entries that are not candidate or confirmed', () => {
    for (const status of ['draft', 'promoted', 'retired'] as const) {
      const entry = baseEntry({ status });
      expect(() =>
        planWorkInventoryPromotion(entry, { kind: 'mission', decided_by: HUMAN, now: NOW })
      ).toThrow(WorkInventoryPromotionError);
    }
    expect(() =>
      planWorkInventoryPromotion(baseEntry({ status: 'confirmed' }), {
        kind: 'mission',
        decided_by: HUMAN,
        now: NOW,
      })
    ).not.toThrow();
  });

  it('refuses a non-human or malformed decided_by', () => {
    const entry = baseEntry();
    const bad = [
      { kind: 'agent', id: 'user:alice' },
      { kind: 'human', id: 'alice' },
      { kind: 'human', id: 'agent:bot' },
    ];
    for (const decidedBy of bad) {
      try {
        planWorkInventoryPromotion(entry, {
          kind: 'mission',
          decided_by: decidedBy as typeof HUMAN,
          now: NOW,
        });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkInventoryPromotionError);
        expect((error as WorkInventoryPromotionError).code).toBe('INVALID_DECIDED_BY');
      }
    }
  });

  it('builds a mission brief that validates against the real mission-brief schema', () => {
    const plan = planWorkInventoryPromotion(baseEntry(), {
      kind: 'mission',
      decided_by: HUMAN,
      now: NOW,
    }) as WorkInventoryMissionPromotionPlan;
    const validate = compileSchema(
      pathResolver.rootResolve('knowledge/product/schemas/mission-brief.schema.json')
    );
    expect(validate(plan.brief)).toBe(true);
    expect(plan.brief.tier).toBe('personal');
    expect(plan.brief.scope.in).toHaveLength(2);
    expect(plan.brief.scope.out?.[0]).toContain('S3');
    expect(plan.brief.victoryConditions[0]).toContain('human steps stay human');
    expect(plan.brief.risks?.[0].risk).toBe('S3 has effect approval');
    expect(plan.create_args).toEqual([
      'create',
      plan.mission_id,
      '--tier',
      'personal',
      '--goal',
      'Weekly sales report',
      '--success-condition',
      plan.brief.victoryConditions[0],
      '--decided-by',
      'user:alice',
    ]);
  });

  it('uses confidential + --tenant-slug for tenant-scoped entries', () => {
    const plan = planWorkInventoryPromotion(baseEntry({ scope: { tenant_slug: 'acme-corp' } }), {
      kind: 'mission',
      decided_by: HUMAN,
      now: NOW,
    }) as WorkInventoryMissionPromotionPlan;
    expect(plan.tier).toBe('confidential');
    expect(plan.brief.tier).toBe('confidential');
    expect(plan.create_args.slice(2, 6)).toEqual([
      '--tier',
      'confidential',
      '--tenant-slug',
      'acme-corp',
    ]);
  });

  it('derives a deterministic mission id within the mission id grammar', () => {
    const entry = baseEntry();
    const a = planWorkInventoryPromotion(entry, { kind: 'mission', decided_by: HUMAN, now: NOW });
    const b = planWorkInventoryPromotion(entry, { kind: 'mission', decided_by: HUMAN, now: LATER });
    expect(a.kind === 'mission' && b.kind === 'mission' && a.mission_id === b.mission_id).toBe(
      true
    );
    expect(workInventoryMissionId('WI-20260922-weekly-sales-report')).toBe(
      'MSN-WI-20260922-WEEKLY-SALES-REPORT'
    );
    const long = workInventoryMissionId(`WI-${'x'.repeat(80)}`);
    expect(long).toMatch(/^[A-Z0-9][A-Z0-9_-]{2,63}$/);
    expect(long).toBe(workInventoryMissionId(`WI-${'x'.repeat(80)}`));
    expect(long).not.toBe(workInventoryMissionId(`WI-${'x'.repeat(79)}y`));
    expect(workInventoryMissionId('WI-abc', 'MSN-OPS')).toBe('MSN-OPS-ABC');
  });

  it('requires a pipeline binding or an on-demand trace observation for pipeline plans', () => {
    expect(() =>
      planWorkInventoryPromotion(baseEntry(), { kind: 'pipeline', decided_by: HUMAN, now: NOW })
    ).toThrow(/NO_PIPELINE_SOURCE/);

    const scheduledOnly = baseEntry({
      observations: [
        {
          source: 'kyberion_trace',
          ref: 'pipeline:baseline-check',
          observed_at: '2026-09-21T00:00:00.000Z',
          digest: '600 runs over last 28d (~150.0/wk), origin scheduled',
          origin: 'scheduled',
        },
      ],
    });
    expect(() =>
      planWorkInventoryPromotion(scheduledOnly, { kind: 'pipeline', decided_by: HUMAN, now: NOW })
    ).toThrow(/NO_PIPELINE_SOURCE/);

    const adhoc = baseEntry({
      observations: [
        {
          source: 'kyberion_trace',
          ref: 'adhoc_pipeline:active/shared/tmp/sales-run.json',
          observed_at: '2026-09-21T00:00:00.000Z',
          digest: '5 runs over last 28d (~1.3/wk), origin on_demand',
        },
      ],
    });
    const plan = planWorkInventoryPromotion(adhoc, {
      kind: 'pipeline',
      decided_by: HUMAN,
      now: NOW,
    });
    expect(plan).toMatchObject({
      kind: 'pipeline',
      input: 'active/shared/tmp/sales-run.json',
      name: 'weekly-sales-report',
      source: { kind: 'observation', ref: 'adhoc_pipeline:active/shared/tmp/sales-run.json' },
      command: 'pnpm',
      args: [
        'pipeline:promote',
        '--input',
        'active/shared/tmp/sales-run.json',
        '--name',
        'weekly-sales-report',
      ],
    });

    const bound = baseEntry();
    bound.steps[0] = { ...bound.steps[0], binding: { pipeline_id: 'sales-export' } };
    expect(
      planWorkInventoryPromotion(bound, { kind: 'pipeline', decided_by: HUMAN, now: NOW })
    ).toMatchObject({
      input: 'pipelines/sales-export.json',
      source: { kind: 'step_binding', step_id: 'S1' },
    });
  });
});

describe('applyWorkInventoryPromotion', () => {
  it('marks the entry promoted with the human decision and ref', () => {
    const entry = baseEntry();
    const plan = planWorkInventoryPromotion(entry, {
      kind: 'mission',
      decided_by: HUMAN,
      now: NOW,
    });
    const promoted = applyWorkInventoryPromotion(entry, plan, { ref: 'MSN-WI-X', now: LATER });
    expect(promoted.status).toBe('promoted');
    expect(promoted.promotion).toEqual({
      kind: 'mission',
      ref: 'MSN-WI-X',
      promoted_at: LATER.toISOString(),
      decided_by: { kind: 'human', id: 'user:alice' },
    });
    expect(entry.status).toBe('candidate'); // input untouched
    expect(() => applyWorkInventoryPromotion(promoted, plan, { ref: 'again' })).toThrow(
      /INVALID_STATUS/
    );
    const other = baseEntry({ entry_id: 'WI-20260922-other' });
    expect(() => applyWorkInventoryPromotion(other, plan, { ref: 'x' })).toThrow(/PLAN_MISMATCH/);
  });
});

describe('executeMissionPromotion (fake exec)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  let missionDir = '';
  let plan: WorkInventoryMissionPromotionPlan;

  beforeEach(() => {
    missionDir = path.join(FIXTURE_PARENT, `work-inventory-promotion-mission-${randomUUID()}`);
    safeMkdir(missionDir, { recursive: true });
    plan = planWorkInventoryPromotion(baseEntry(), {
      kind: 'mission',
      decided_by: HUMAN,
      now: NOW,
    }) as WorkInventoryMissionPromotionPlan;
    mocks.findMissionPath.mockReset();
    mocks.loadState.mockReset();
    mocks.listApprovalRequests.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    if (missionDir) safeRmSync(missionDir, { recursive: true, force: true });
  });

  it('creates the mission, writes the brief, and opens alignment', () => {
    let exists = false;
    mocks.findMissionPath.mockImplementation(() => (exists ? missionDir : null));
    mocks.loadState.mockReturnValue({ status: 'planned' });
    const calls: Array<{ args: string[]; role?: string }> = [];
    const exec: WorkInventoryPromotionExec = (_command, args, options) => {
      calls.push({ args, role: options.env.MISSION_ROLE });
      if (args[0] === 'dist/scripts/mission_controller.js') {
        exists = true;
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ requestId: 'REQ-1' }), stderr: '', status: 0 };
    };

    const result = executeMissionPromotion(plan, { exec });
    expect(result).toEqual({
      mission_id: plan.mission_id,
      approval_request_id: 'REQ-1',
      created: true,
    });
    expect(calls[0]).toEqual({
      args: ['dist/scripts/mission_controller.js', ...plan.create_args],
      role: 'mission_controller',
    });
    expect(calls[1].args).toEqual([
      'dist/scripts/mission_alignment_request.js',
      '--mission',
      plan.mission_id,
      '--json',
    ]);
    const brief = JSON.parse(
      String(
        safeReadFile(path.join(missionDir, 'evidence', 'mission-brief.json'), { encoding: 'utf8' })
      )
    );
    expect(brief).toEqual(plan.brief);
  });

  it('is idempotent for an existing mission: skips create and keeps the brief', () => {
    mocks.findMissionPath.mockReturnValue(missionDir);
    safeMkdir(path.join(missionDir, 'evidence'), { recursive: true });
    const briefPath = path.join(missionDir, 'evidence', 'mission-brief.json');
    safeWriteFile(briefPath, '{"title":"approved brief"}\n', { encoding: 'utf8' });
    mocks.listApprovalRequests.mockReturnValue([
      { id: 'REQ-EXISTING', correlationId: `mission-alignment-${plan.mission_id}` },
    ]);
    const exec = vi.fn<WorkInventoryPromotionExec>(() => ({
      stdout: 'not json',
      stderr: '',
      status: 0,
    }));

    const result = executeMissionPromotion(plan, { exec });
    expect(result).toEqual({
      mission_id: plan.mission_id,
      approval_request_id: 'REQ-EXISTING',
      created: false,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toBe('dist/scripts/mission_alignment_request.js');
    expect(String(safeReadFile(briefPath, { encoding: 'utf8' }))).toBe(
      '{"title":"approved brief"}\n'
    );
  });

  it('fails when create exits 0 but the mission is not planned', () => {
    mocks.findMissionPath.mockReturnValue(null);
    const exec: WorkInventoryPromotionExec = () => ({ stdout: '', stderr: '', status: 0 });
    expect(() => executeMissionPromotion(plan, { exec })).toThrow(/MISSION_NOT_CREATED/);
  });

  it('refuses pipeline plans', () => {
    const bound = baseEntry();
    bound.steps[0] = { ...bound.steps[0], binding: { pipeline_id: 'sales-export' } };
    const pipelinePlan = planWorkInventoryPromotion(bound, {
      kind: 'pipeline',
      decided_by: HUMAN,
      now: NOW,
    });
    expect(() => executeMissionPromotion(pipelinePlan, { exec: vi.fn() })).toThrow(/PLAN_MISMATCH/);
  });
});

describe('outcomes', () => {
  it('computes runs, failures, and minutes saved from matching signals', () => {
    const entry = promotedPipelineEntry();
    const outcome = measureWorkInventoryOutcome(
      entry,
      [
        signal({}),
        signal({ signature: 'pipeline:unrelated', count: 99 }),
        // Latest run predates the promotion: no post-promotion runs.
        signal({
          last_at: '2026-09-01T00:00:00.000Z',
          signature: 'adhoc_pipeline:weekly-sales-report',
        }),
      ],
      { now: LATER }
    );
    // 4 runs × 30 min × (1 − 1/4)
    expect(outcome).toEqual({
      measured_at: LATER.toISOString(),
      runs: 4,
      minutes_saved_estimate: 90,
      failures: 1,
      source: 'kyberion_trace',
    });
  });

  it('reports zero savings when nothing ran', () => {
    const outcome = measureWorkInventoryOutcome(promotedPipelineEntry(), [], { now: LATER });
    expect(outcome).toMatchObject({ runs: 0, failures: 0, minutes_saved_estimate: 0 });
  });

  it('refuses unpromoted entries and dedupes outcomes by measured_at', () => {
    expect(() => measureWorkInventoryOutcome(baseEntry(), [], { now: LATER })).toThrow(
      /NOT_PROMOTED/
    );
    const entry = promotedPipelineEntry();
    const first = measureWorkInventoryOutcome(entry, [signal({})], { now: LATER });
    const once = recordWorkInventoryOutcome(entry, first);
    const twice = recordWorkInventoryOutcome(once, { ...first, runs: 5 });
    expect(twice.outcomes).toHaveLength(1);
    expect(twice.outcomes?.[0].runs).toBe(5);
    const third = recordWorkInventoryOutcome(twice, { ...first, measured_at: NOW.toISOString() });
    expect(third.outcomes?.map((o) => o.measured_at)).toEqual([
      NOW.toISOString(),
      LATER.toISOString(),
    ]);
  });
});

describe('learning', () => {
  function withOutcome(entry: WorkInventoryEntry, runs: number, failures: number) {
    return recordWorkInventoryOutcome(entry, {
      measured_at: LATER.toISOString(),
      runs,
      failures,
      minutes_saved_estimate: 0,
      source: 'kyberion_trace',
    });
  }

  it('builds calibration samples only from promoted, non-human-only entries with runs', () => {
    const measured = withOutcome(promotedPipelineEntry(), 4, 1);
    const zeroRuns = withOutcome(promotedPipelineEntry({ entry_id: 'WI-20260922-zero' }), 0, 0);
    const humanOnly = withOutcome(
      promotedPipelineEntry({
        entry_id: 'WI-20260922-human-only',
        steps: [baseEntry().steps[2]],
      }),
      4,
      0
    );
    const samples = buildCalibrationSamples([measured, zeroRuns, humanOnly, baseEntry()]);
    expect(samples).toEqual([
      {
        entry_id: measured.entry_id,
        method_mix: { ai_reasoning: 0.3333, human: 0.3333, program: 0.3333 },
        predicted_automatable_ratio: 0.5667,
        realized_automatable_ratio: 0.75,
      },
    ]);
  });

  it('flags prediction gaps above the threshold only', () => {
    const small = withOutcome(promotedPipelineEntry(), 4, 1); // realized 0.75 vs 0.5667
    const large = withOutcome(
      promotedPipelineEntry({ entry_id: 'WI-20260922-large', scope: { tenant_slug: 'acme-corp' } }),
      4,
      0
    ); // realized 1 vs 0.5667
    const signals = detectWorkInventoryLearningSignals([small, large]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalId: 'work-inventory-gap-WI-20260922-large',
      sourceType: 'routine_exception',
      targetKind: 'knowledge_hint',
      tier: 'confidential',
      tenantSlug: 'acme-corp',
      metadata: { predicted: 0.5667, realized: 1, gap: 0.4333 },
    });
    expect(detectWorkInventoryLearningSignals([small, large], { gapThreshold: 0.1 })).toHaveLength(
      2
    );
    expect(
      detectWorkInventoryLearningSignals([small, large], { tenantSlug: 'other-co' })
    ).toHaveLength(0);
  });

  it('flags a taxonomy rule overridden at least overrideThreshold times per scope', () => {
    const overridden = (id: string, tenant?: string) =>
      baseEntry({
        entry_id: id,
        scope: tenant ? { tenant_slug: tenant } : {},
        steps: [
          step({
            method: { assigned: 'human', source: 'human_override', rationale: 'we check by hand' },
          }),
          // Override that agrees with the rule — never counted.
          step({
            step_id: 'S2',
            verb: 'manage',
            method: { assigned: 'program', source: 'human_override', rationale: 'same' },
          }),
        ],
      });
    const personal = [overridden('WI-20260922-a'), overridden('WI-20260922-b')];
    expect(detectWorkInventoryLearningSignals(personal)).toEqual([]);

    const three = [...personal, overridden('WI-20260922-c')];
    const signals = detectWorkInventoryLearningSignals(three);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalId: 'work-inventory-rule-override-transform-to-program',
      sourceType: 'governance_decision',
      targetKind: 'pattern',
      title: 'Classification rule transform-to-program is often overridden',
      tier: 'personal',
      metadata: { rule_id: 'transform-to-program', override_count: 3, overridden_to: { human: 3 } },
    });

    // Scopes never pool: two personal + one tenant override stay below threshold.
    const mixed = [...personal, overridden('WI-20260922-t', 'acme-corp')];
    expect(detectWorkInventoryLearningSignals(mixed)).toEqual([]);
    expect(detectWorkInventoryLearningSignals(mixed, { overrideThreshold: 2 })).toHaveLength(1);
  });

  it('emits via enqueueOperationalLearningSignal with the scope tier', () => {
    mocks.enqueue.mockReset().mockImplementation((s: { signalId: string }) => `ops-${s.signalId}`);
    const ids = emitWorkInventoryLearningSignals(
      [
        {
          signalId: 'a',
          sourceType: 'routine_exception',
          sourceRef: 'r',
          title: 't',
          summary: 's',
          tenantSlug: 'acme-corp',
        },
        {
          signalId: 'b',
          sourceType: 'routine_exception',
          sourceRef: 'r',
          title: 't',
          summary: 's',
        },
      ],
      { now: LATER }
    );
    expect(ids).toEqual(['ops-a', 'ops-b']);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      tier: 'confidential',
      tenantSlug: 'acme-corp',
    });
    expect(mocks.enqueue.mock.calls[1][0]).toMatchObject({ tier: 'personal' });
    expect(mocks.enqueue.mock.calls[1][0].tenantSlug).toBeUndefined();
  });
});

describe('runWorkInventoryLearningCycle (hermetic)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  let fixtureRoot = '';

  beforeEach(() => {
    fixtureRoot = path.join(FIXTURE_PARENT, `work-inventory-learning-cycle-${randomUUID()}`);
    safeMkdir(fixtureRoot, { recursive: true });
    mocks.enqueue.mockReset().mockImplementation((s: { signalId: string }) => `ops-${s.signalId}`);
  });

  afterEach(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('measures, records, calibrates, and emits learning signals', () => {
    const scope = { tenant_slug: 'acme-corp' };
    const promoted = promotedPipelineEntry({ scope });
    const untouched = baseEntry({ entry_id: 'WI-20260922-not-promoted', scope });
    saveWorkInventoryEntry(promoted, { rootDir: fixtureRoot });
    saveWorkInventoryEntry(untouched, { rootDir: fixtureRoot });

    const summary = runWorkInventoryLearningCycle({
      scope,
      rootDir: fixtureRoot,
      now: LATER,
      signals: [signal({ failure_count: 0 })],
    });

    expect(summary.measured).toBe(1);
    expect(summary.calibrated_methods).toEqual(['ai_reasoning']); // program is already at 1
    expect(summary.learning_signals.map((s) => s.signalId)).toEqual([
      `work-inventory-gap-${promoted.entry_id}`,
    ]);
    expect(summary.enqueued).toEqual([`ops-work-inventory-gap-${promoted.entry_id}`]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      tier: 'confidential',
      tenantSlug: 'acme-corp',
    });

    const saved = listWorkInventoryEntries(scope, { rootDir: fixtureRoot });
    const savedPromoted = saved.find((e) => e.entry_id === promoted.entry_id);
    expect(savedPromoted?.outcomes).toEqual([
      {
        measured_at: LATER.toISOString(),
        runs: 4,
        failures: 0,
        minutes_saved_estimate: 120,
        source: 'kyberion_trace',
      },
    ]);
    expect(saved.find((e) => e.entry_id === untouched.entry_id)?.outcomes).toBeUndefined();

    const calibrationPath = path.join(
      fixtureRoot,
      'knowledge/confidential/acme-corp/work-inventory/calibration.json'
    );
    expect(safeExistsSync(calibrationPath)).toBe(true);
    const calibration = loadWorkInventoryCalibration(scope, { rootDir: fixtureRoot });
    expect(calibration.history.at(-1)?.reason).toBe('learning-cycle 2026-10-20');
    expect(calibration.method_automatable.ai_reasoning).toBeGreaterThan(0.7);
  });
});
