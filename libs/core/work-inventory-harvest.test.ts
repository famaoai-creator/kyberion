import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  applyClassification,
  createWorkInventoryEntry,
  validateWorkInventoryEntry,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from './work-inventory.js';
import {
  attachDemandSignals,
  collectKyberionDemandSignals,
  matchSignalsToEntries,
  suggestEntriesFromSignals,
  type DemandSignal,
} from './work-inventory-harvest.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const ATTRIBUTE_SENTINEL = 'SENTINEL_TRACE_ATTRIBUTE_TEXT_9f31';
const EVENT_SENTINEL = 'SENTINEL_TRACE_EVENT_TEXT_2b74';
const UTTERANCE_SENTINEL = 'SENTINEL_UTTERANCE_TEXT_a017';

interface TraceLineInput {
  traceId: string;
  name: string;
  startedAt: string;
  completedAt?: string;
  status?: 'ok' | 'error' | 'in_progress';
  tenantSlug?: string;
}

function traceLine(input: TraceLineInput): string {
  return JSON.stringify({
    traceId: input.traceId,
    rootSpan: {
      spanId: `${input.traceId}-root`,
      name: input.name,
      startTime: input.startedAt,
      endTime: input.completedAt,
      status: input.status ?? 'ok',
      attributes: { note: ATTRIBUTE_SENTINEL },
      events: [
        { name: 'observed', timestamp: input.startedAt, attributes: { msg: EVENT_SENTINEL } },
      ],
      artifacts: [],
      knowledgeRefs: [],
      children: [],
    },
    metadata: {
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    },
  });
}

function step(overrides: Partial<WorkInventoryStep> = {}): WorkInventoryStep {
  return {
    step_id: 'S1',
    stage: 'act',
    verb: 'operate',
    description: 'do the thing',
    data_sensitivity: 'internal',
    effects: [],
    method: { assigned: 'human', source: 'proposal', rationale: 'initial guess' },
    ...overrides,
  };
}

describe('work inventory harvest (hermetic)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  let fixtureRoot = '';
  let tracesDir = '';

  beforeEach(() => {
    fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'work-inventory-harvest-test-'));
    tracesDir = path.join(fixtureRoot, 'active', 'shared', 'logs', 'traces');
    fs.mkdirSync(tracesDir, { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'active', 'shared', 'runtime', 'feedback-loop'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(fixtureRoot, 'active', 'shared', 'tmp'), { recursive: true });

    const lines: string[] = [
      // Signature A: pipeline:demo-pipeline — 3 ok runs, durations 1000/2000/3000ms.
      traceLine({
        traceId: 't-a1',
        name: 'pipeline:demo-pipeline',
        startedAt: '2026-09-20T10:00:00.000Z',
        completedAt: '2026-09-20T10:00:01.000Z',
      }),
      traceLine({
        traceId: 't-a2',
        name: 'pipeline:demo-pipeline',
        startedAt: '2026-09-20T11:00:00.000Z',
        completedAt: '2026-09-20T11:00:02.000Z',
      }),
      traceLine({
        traceId: 't-a3',
        name: 'pipeline:demo-pipeline',
        startedAt: '2026-09-20T12:00:00.000Z',
        completedAt: '2026-09-20T12:00:03.000Z',
      }),
      // Signature B: browser-pipeline:browser-test — 2 runs (below default minCount).
      traceLine({
        traceId: 't-b1',
        name: 'browser-pipeline:browser-test',
        startedAt: '2026-09-20T09:00:00.000Z',
        completedAt: '2026-09-20T09:00:01.000Z',
      }),
      traceLine({
        traceId: 't-b2',
        name: 'browser-pipeline:browser-test',
        startedAt: '2026-09-20T09:10:00.000Z',
        completedAt: '2026-09-20T09:10:01.000Z',
      }),
      // Signature C: voice-actuator:speak_local — 3 ok + 1 error.
      traceLine({
        traceId: 't-c1',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-21T01:00:00.000Z',
        completedAt: '2026-09-21T01:00:00.100Z',
      }),
      traceLine({
        traceId: 't-c2',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-21T02:00:00.000Z',
        completedAt: '2026-09-21T02:00:00.200Z',
      }),
      traceLine({
        traceId: 't-c3',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-21T03:00:00.000Z',
        completedAt: '2026-09-21T03:00:00.300Z',
      }),
      traceLine({
        traceId: 't-c4',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-21T04:00:00.000Z',
        completedAt: '2026-09-21T04:00:00.400Z',
        status: 'error',
      }),
      // Signature D: mission_run — 2 runs.
      traceLine({
        traceId: 't-d1',
        name: 'mission_run',
        startedAt: '2026-09-21T05:00:00.000Z',
        completedAt: '2026-09-21T05:01:00.000Z',
      }),
      traceLine({
        traceId: 't-d2',
        name: 'mission_run',
        startedAt: '2026-09-21T06:00:00.000Z',
        completedAt: '2026-09-21T06:01:00.000Z',
      }),
      // Bookkeeping spans — must never become signals.
      traceLine({
        traceId: 't-bk1',
        name: 'mission_task_dispatch',
        startedAt: '2026-09-21T07:00:00.000Z',
      }),
      traceLine({
        traceId: 't-bk2',
        name: 'mission_task_dispatch',
        startedAt: '2026-09-21T07:05:00.000Z',
      }),
      traceLine({
        traceId: 't-bk3',
        name: 'mission:checkpoint',
        startedAt: '2026-09-21T07:10:00.000Z',
      }),
      traceLine({
        traceId: 't-bk4',
        name: 'mission_controller:checkpoint:MSN-X',
        startedAt: '2026-09-21T07:15:00.000Z',
      }),
      // Window-excluded: same day file, but well outside the default 28-day window.
      traceLine({
        traceId: 't-old',
        name: 'pipeline:window-excluded-test',
        startedAt: '2026-07-01T00:00:00.000Z',
      }),
      // Tenant scoping: same signature, three tenant scopes.
      traceLine({
        traceId: 't-tenant-a',
        name: 'pipeline:tenant-scope-test',
        startedAt: '2026-09-20T13:00:00.000Z',
        tenantSlug: 'tenant-a',
      }),
      traceLine({
        traceId: 't-tenant-b',
        name: 'pipeline:tenant-scope-test',
        startedAt: '2026-09-20T13:05:00.000Z',
        tenantSlug: 'tenant-b',
      }),
      traceLine({
        traceId: 't-tenant-unscoped',
        name: 'pipeline:tenant-scope-test',
        startedAt: '2026-09-20T13:10:00.000Z',
      }),
      // Malformed line — must be skipped, never throw.
      '{not valid json',
      '', // blank line — also skipped
    ];
    fs.writeFileSync(path.join(tracesDir, 'traces-2026-09-20.jsonl'), lines.join('\n'));

    fs.writeFileSync(
      path.join(fixtureRoot, 'active/shared/runtime/feedback-loop/adhoc-pipeline-runs.json'),
      JSON.stringify(
        [
          { path: 'pipelines/foo-adhoc.json', count: 5, last_at: '2026-09-19T00:00:00.000Z' },
          { path: 'pipelines/bar-adhoc.json', count: 2, last_at: '2026-01-01T00:00:00.000Z' },
        ],
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(fixtureRoot, 'active/shared/tmp/unhandled-intent-registry.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          entries: [
            {
              miss_type: 'unrouted',
              intent_id: 'rotate-secret',
              utterance_samples: ['secretを更新して'],
              first_seen: '2026-09-15T00:00:00.000Z',
              last_seen: '2026-09-19T00:00:00.000Z',
              occurrence_count: 5,
              reconciled: false,
            },
            {
              miss_type: 'unrecognized',
              utterance_samples: [UTTERANCE_SENTINEL],
              first_seen: '2026-09-21T00:00:00.000Z',
              last_seen: '2026-09-21T00:10:00.000Z',
              occurrence_count: 4,
              reconciled: false,
            },
          ],
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  describe('collectKyberionDemandSignals', () => {
    it('aggregates pipeline, actuator, and mission root spans, skipping bookkeeping spans', () => {
      const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      const bySig = new Map(signals.map((s) => [s.signature, s]));

      const a = bySig.get('pipeline:demo-pipeline');
      expect(a).toBeDefined();
      expect(a?.kind).toBe('pipeline');
      expect(a?.count).toBe(3);
      expect(a?.median_duration_ms).toBe(2000);
      expect(a?.failure_count).toBe(0);
      expect(a?.per_week).toBeCloseTo(3 / 4, 5); // 28-day default window => /4 weeks
      expect(a?.sample_refs).toEqual(['t-a1', 't-a2', 't-a3']);

      const b = bySig.get('browser-pipeline:browser-test');
      expect(b?.kind).toBe('pipeline');
      expect(b?.count).toBe(2);

      const c = bySig.get('voice-actuator:speak_local');
      expect(c?.kind).toBe('actuator_op');
      expect(c?.count).toBe(4);
      expect(c?.median_duration_ms).toBe(250); // [100,200,300,400] -> (200+300)/2
      expect(c?.failure_count).toBe(1);

      const d = bySig.get('mission_run');
      expect(d?.kind).toBe('mission');
      expect(d?.count).toBe(2);

      expect(bySig.has('mission_task_dispatch')).toBe(false);
      expect(bySig.has('mission:checkpoint')).toBe(false);
      expect(bySig.has('mission_controller:checkpoint:MSN-X')).toBe(false);
    });

    it('excludes traces outside the window by default, and includes them when since is widened', () => {
      const withoutWideWindow = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      expect(
        withoutWideWindow.find((s) => s.signature === 'pipeline:window-excluded-test')
      ).toBeUndefined();

      const withWideWindow = collectKyberionDemandSignals({
        rootDir: fixtureRoot,
        now: NOW,
        since: new Date('2026-01-01T00:00:00.000Z'),
      });
      const found = withWideWindow.find((s) => s.signature === 'pipeline:window-excluded-test');
      expect(found?.count).toBe(1);
    });

    it('never leaks trace attribute or event text into signals', () => {
      const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      const serialized = JSON.stringify(signals);
      expect(serialized).not.toContain(ATTRIBUTE_SENTINEL);
      expect(serialized).not.toContain(EVENT_SENTINEL);
    });

    it('never leaks unhandled-intent utterance text, and drops misses with no scored intent id', () => {
      const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      const serialized = JSON.stringify(signals);
      expect(serialized).not.toContain(UTTERANCE_SENTINEL);

      const intentSignal = signals.find((s) => s.signature === 'intent:rotate-secret');
      expect(intentSignal?.kind).toBe('unhandled_intent');
      expect(intentSignal?.count).toBe(5);

      // The 'unrecognized' entry has no intent_id, so it produces no signal at all.
      expect(signals.some((s) => s.kind === 'unhandled_intent' && s.count === 4)).toBe(false);
    });

    it('computes per_week for the ad-hoc ledger only when last_at falls inside the window', () => {
      const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      const fresh = signals.find((s) => s.signature === 'adhoc_pipeline:pipelines/foo-adhoc.json');
      const stale = signals.find((s) => s.signature === 'adhoc_pipeline:pipelines/bar-adhoc.json');
      expect(fresh?.kind).toBe('adhoc_pipeline');
      expect(fresh?.count).toBe(5);
      expect(fresh?.per_week).toBeGreaterThan(0);
      expect(stale?.count).toBe(2); // count always reported, even when stale
      expect(stale?.per_week).toBe(0);
    });

    describe('tenant scoping', () => {
      it('scopes to only the requested tenant by default', () => {
        const signals = collectKyberionDemandSignals({
          rootDir: fixtureRoot,
          now: NOW,
          tenantSlug: 'tenant-a',
        });
        const signal = signals.find((s) => s.signature === 'pipeline:tenant-scope-test');
        expect(signal?.count).toBe(1);
        expect(signal?.sample_refs).toEqual(['t-tenant-a']);
      });

      it('adds the unscoped trace only when includeUnscoped is set', () => {
        const signals = collectKyberionDemandSignals({
          rootDir: fixtureRoot,
          now: NOW,
          tenantSlug: 'tenant-a',
          includeUnscoped: true,
        });
        const signal = signals.find((s) => s.signature === 'pipeline:tenant-scope-test');
        expect(signal?.count).toBe(2);
        expect(signal?.sample_refs.sort()).toEqual(['t-tenant-a', 't-tenant-unscoped']);
      });

      it('excludes every tenant trace from the personal (no tenantSlug) scope', () => {
        const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
        const signal = signals.find((s) => s.signature === 'pipeline:tenant-scope-test');
        expect(signal?.count).toBe(1);
        expect(signal?.sample_refs).toEqual(['t-tenant-unscoped']);
      });

      it('never mixes tenant-b traces into a tenant-a request', () => {
        const signals = collectKyberionDemandSignals({
          rootDir: fixtureRoot,
          now: NOW,
          tenantSlug: 'tenant-a',
          includeUnscoped: true,
        });
        const signal = signals.find((s) => s.signature === 'pipeline:tenant-scope-test');
        expect(signal?.sample_refs).not.toContain('t-tenant-b');
      });
    });

    it('sorts by count descending, then signature ascending', () => {
      const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
      for (let i = 1; i < signals.length; i += 1) {
        const prev = signals[i - 1];
        const cur = signals[i];
        expect(
          prev.count > cur.count || (prev.count === cur.count && prev.signature <= cur.signature)
        ).toBe(true);
      }
    });
  });

  describe('matchSignalsToEntries', () => {
    const signals: DemandSignal[] = [
      {
        signature: 'pipeline:demo-pipeline',
        kind: 'pipeline',
        count: 5,
        first_at: '2026-09-01T00:00:00.000Z',
        last_at: '2026-09-20T00:00:00.000Z',
        per_week: 1,
        failure_count: 0,
        window_days: 28,
        sample_refs: ['t-a1'],
      },
      {
        signature: 'voice-actuator:speak_local',
        kind: 'actuator_op',
        count: 4,
        first_at: '2026-09-01T00:00:00.000Z',
        last_at: '2026-09-21T00:00:00.000Z',
        per_week: 1,
        failure_count: 1,
        window_days: 28,
        sample_refs: ['t-c1'],
      },
      {
        signature: 'mission_run',
        kind: 'mission',
        count: 2,
        first_at: '2026-09-01T00:00:00.000Z',
        last_at: '2026-09-21T00:00:00.000Z',
        per_week: 0.5,
        failure_count: 0,
        window_days: 28,
        sample_refs: [],
      },
    ];

    it('matches via a pipeline_id binding given as a bare id or a pipelines/<id>.json path', () => {
      const entryBareId = createWorkInventoryEntry(
        {
          title: 'entry bare id',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          steps: [step({ binding: { pipeline_id: 'demo-pipeline' } })],
        },
        NOW
      );
      const entryPath = createWorkInventoryEntry(
        {
          title: 'entry path',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          steps: [step({ binding: { pipeline_id: 'pipelines/demo-pipeline.json' } })],
        },
        NOW
      );
      const matches = matchSignalsToEntries([entryBareId, entryPath], signals);
      expect(matches.get(entryBareId.entry_id)?.map((s) => s.signature)).toEqual([
        'pipeline:demo-pipeline',
      ]);
      expect(matches.get(entryPath.entry_id)?.map((s) => s.signature)).toEqual([
        'pipeline:demo-pipeline',
      ]);
    });

    it('matches via an actuator+op binding', () => {
      const entry = createWorkInventoryEntry(
        {
          title: 'entry actuator',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          steps: [step({ binding: { actuator: 'voice-actuator', op: 'speak_local' } })],
        },
        NOW
      );
      const matches = matchSignalsToEntries([entry], signals);
      expect(matches.get(entry.entry_id)?.map((s) => s.signature)).toEqual([
        'voice-actuator:speak_local',
      ]);
    });

    it('matches via an existing kyberion_trace observation ref', () => {
      const entry: WorkInventoryEntry = {
        ...createWorkInventoryEntry(
          { title: 'entry obs', scope: {}, trigger: { kind: 'ad_hoc', description: 'test' } },
          NOW
        ),
        observations: [
          { source: 'kyberion_trace', ref: 'mission_run', observed_at: '2026-09-21T00:00:00.000Z' },
        ],
      };
      const matches = matchSignalsToEntries([entry], signals);
      expect(matches.get(entry.entry_id)?.map((s) => s.signature)).toEqual(['mission_run']);
    });

    it('does not match an entry with unrelated bindings', () => {
      const entry = createWorkInventoryEntry(
        {
          title: 'entry unrelated',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          steps: [step({ binding: { actuator: 'email-actuator', op: 'send' } })],
        },
        NOW
      );
      const matches = matchSignalsToEntries([entry], signals);
      expect(matches.has(entry.entry_id)).toBe(false);
    });
  });

  describe('attachDemandSignals', () => {
    const signal: DemandSignal = {
      signature: 'pipeline:demo-pipeline',
      kind: 'pipeline',
      count: 3,
      first_at: '2026-09-20T10:00:00.000Z',
      last_at: '2026-09-20T12:00:00.000Z',
      per_week: 0.75,
      median_duration_ms: 2000,
      failure_count: 0,
      window_days: 28,
      sample_refs: ['t-a1', 't-a2', 't-a3'],
    };

    it('adds a kyberion_trace observation without touching self-reported fields', () => {
      const entry = createWorkInventoryEntry(
        {
          title: 'entry',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          frequency: { per: 'week', count: 9 },
          effort_minutes_per_run: 42,
        },
        NOW
      );
      const updated = attachDemandSignals(entry, [signal], NOW);
      expect(updated.observations).toHaveLength(1);
      expect(updated.observations?.[0]).toMatchObject({
        source: 'kyberion_trace',
        ref: 'pipeline:demo-pipeline',
        observed_at: '2026-09-20T12:00:00.000Z',
        metrics: {
          count: 3,
          per_week: 0.75,
          median_duration_ms: 2000,
          failure_count: 0,
          window_days: 28,
        },
      });
      expect(updated.frequency).toEqual({ per: 'week', count: 9 });
      expect(updated.effort_minutes_per_run).toBe(42);
      expect(validateWorkInventoryEntry(updated).valid).toBe(true);
    });

    it('is idempotent: re-attaching the same signature upserts rather than duplicates', () => {
      const entry = createWorkInventoryEntry(
        { title: 'entry', scope: {}, trigger: { kind: 'ad_hoc', description: 'test' } },
        NOW
      );
      const once = attachDemandSignals(entry, [signal], NOW);
      const updatedSignal: DemandSignal = { ...signal, count: 4, per_week: 1 };
      const twice = attachDemandSignals(once, [updatedSignal], NOW);
      expect(twice.observations).toHaveLength(1);
      expect(twice.observations?.[0].metrics?.count).toBe(4);
    });

    it('preserves observations from other sources untouched', () => {
      const entry: WorkInventoryEntry = {
        ...createWorkInventoryEntry(
          { title: 'entry', scope: {}, trigger: { kind: 'ad_hoc', description: 'test' } },
          NOW
        ),
        observations: [
          { source: 'self_report', ref: 'member-note', observed_at: '2026-09-01T00:00:00.000Z' },
        ],
      };
      const updated = attachDemandSignals(entry, [signal], NOW);
      expect(updated.observations).toHaveLength(2);
      expect(updated.observations?.some((o) => o.source === 'self_report')).toBe(true);
    });
  });

  describe('suggestEntriesFromSignals', () => {
    const signals: DemandSignal[] = [
      {
        signature: 'pipeline:demo-pipeline',
        kind: 'pipeline',
        count: 3,
        first_at: '2026-09-20T10:00:00.000Z',
        last_at: '2026-09-20T12:00:00.000Z',
        per_week: 0.75,
        median_duration_ms: 2000,
        failure_count: 0,
        window_days: 28,
        sample_refs: ['t-a1'],
      },
      {
        signature: 'browser-pipeline:browser-test',
        kind: 'pipeline',
        count: 2, // below minCount
        first_at: '2026-09-20T09:00:00.000Z',
        last_at: '2026-09-20T09:10:00.000Z',
        per_week: 0.5,
        failure_count: 0,
        window_days: 28,
        sample_refs: ['t-b1'],
      },
      {
        signature: 'voice-actuator:speak_local',
        kind: 'actuator_op',
        count: 4,
        first_at: '2026-09-21T01:00:00.000Z',
        last_at: '2026-09-21T04:00:00.000Z',
        per_week: 1,
        median_duration_ms: 250,
        failure_count: 1,
        window_days: 28,
        sample_refs: ['t-c1'],
      },
      {
        signature: 'intent:rotate-secret',
        kind: 'unhandled_intent',
        count: 5,
        first_at: '2026-09-15T00:00:00.000Z',
        last_at: '2026-09-19T00:00:00.000Z',
        per_week: 1.25,
        failure_count: 0,
        window_days: 28,
        sample_refs: [],
      },
    ];

    it('drafts a valid entry only for unmatched signals at or above minCount', () => {
      const drafts = suggestEntriesFromSignals(signals, [], { now: NOW });
      const signatures = drafts.map((d) => d.observations?.[0]?.ref);
      expect(signatures.sort()).toEqual(
        ['intent:rotate-secret', 'pipeline:demo-pipeline', 'voice-actuator:speak_local'].sort()
      );
      for (const draft of drafts) {
        expect(draft.status).toBe('draft');
        expect(draft.trigger.kind).toBe('request');
        expect(validateWorkInventoryEntry(draft)).toEqual({ valid: true, errors: [] });
      }
    });

    it('derives method from the taxonomy rules, never assigning it directly', () => {
      const [draft] = suggestEntriesFromSignals(
        signals.filter((s) => s.signature === 'pipeline:demo-pipeline'),
        [],
        { now: NOW }
      );
      expect(draft.steps[0].method.source).toBe('rule');
      // Re-running classification is stable on assigned/rule_id (the rationale
      // text differs slightly because the first pass also records the
      // overridden initial "proposal", which the second pass no longer has).
      const reclassified = applyClassification(draft);
      expect(reclassified.steps[0].method.assigned).toBe(draft.steps[0].method.assigned);
      expect(reclassified.steps[0].method.rule_id).toBe(draft.steps[0].method.rule_id);
    });

    it('falls back to operate for an actuator absent from every candidate_bindings list', () => {
      const [draft] = suggestEntriesFromSignals(
        signals.filter((s) => s.signature === 'voice-actuator:speak_local'),
        [],
        { now: NOW }
      );
      expect(draft.steps[0].binding).toMatchObject({
        actuator: 'voice-actuator',
        op: 'speak_local',
      });
      expect(draft.steps[0].verb).toBe('operate'); // voice-actuator has no taxonomy candidate_binding
    });

    it('binds an actuator_op signal to the taxonomy verb whose candidate_bindings contains that actuator', () => {
      const meetingSignal: DemandSignal = {
        signature: 'meeting-actuator:speak',
        kind: 'actuator_op',
        count: 6,
        first_at: '2026-09-01T00:00:00.000Z',
        last_at: '2026-09-21T00:00:00.000Z',
        per_week: 1.5,
        failure_count: 0,
        window_days: 28,
        sample_refs: [],
      };
      const [draft] = suggestEntriesFromSignals([meetingSignal], [], { now: NOW });
      expect(draft.steps[0].binding).toMatchObject({ actuator: 'meeting-actuator', op: 'speak' });
      expect(draft.steps[0].verb).toBe('communicate');
    });

    it('skips a signal already matched to an existing entry', () => {
      const existing = createWorkInventoryEntry(
        {
          title: 'already tracked',
          scope: {},
          trigger: { kind: 'ad_hoc', description: 'test' },
          steps: [step({ binding: { pipeline_id: 'demo-pipeline' } })],
        },
        NOW
      );
      const drafts = suggestEntriesFromSignals(signals, [existing], { now: NOW });
      expect(drafts.some((d) => d.observations?.[0]?.ref === 'pipeline:demo-pipeline')).toBe(false);
    });

    it('respects a custom minCount', () => {
      const drafts = suggestEntriesFromSignals(signals, [], { now: NOW, minCount: 5 });
      expect(drafts.map((d) => d.observations?.[0]?.ref)).toEqual(['intent:rotate-secret']);
    });

    it('applies the given scope to every draft', () => {
      const drafts = suggestEntriesFromSignals(signals, [], {
        now: NOW,
        scope: { tenant_slug: 'acme-corp' },
      });
      expect(drafts.every((d) => d.scope.tenant_slug === 'acme-corp')).toBe(true);
    });
  });
});
