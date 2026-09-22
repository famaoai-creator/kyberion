import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  applyClassification,
  createWorkInventoryEntry,
  migrateInferredBindings,
  validateWorkInventoryEntry,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from './work-inventory.js';
import {
  attachDemandSignals,
  collectKyberionDemandSignals,
  collectKyberionDemandSignalsWithStats,
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
  /** WI-13: `Trace['metadata']['origin']`; absent -> legacy untagged trace. */
  origin?: 'test' | 'ci' | 'scheduled' | 'agent' | 'interactive';
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
      ...(input.origin ? { origin: input.origin } : {}),
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
    fixtureRoot = path.join(FIXTURE_PARENT, `work-inventory-harvest-test-${randomUUID()}`);
    safeMkdir(fixtureRoot, { recursive: true });
    tracesDir = path.join(fixtureRoot, 'active', 'shared', 'logs', 'traces');
    safeMkdir(tracesDir, { recursive: true });
    safeMkdir(path.join(fixtureRoot, 'active', 'shared', 'runtime', 'feedback-loop'), {
      recursive: true,
    });
    safeMkdir(path.join(fixtureRoot, 'active', 'shared', 'tmp'), { recursive: true });

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
    safeWriteFile(path.join(tracesDir, 'traces-2026-09-20.jsonl'), lines.join('\n'));

    // Pipeline definitions for origin resolution: demo-pipeline has no
    // schedule (on demand), tenant-scope-test has an enabled schedule,
    // window-excluded-test has a disabled schedule; browser-test has no file.
    const pipelinesDir = path.join(fixtureRoot, 'pipelines');
    safeMkdir(pipelinesDir, { recursive: true });
    safeWriteFile(
      path.join(pipelinesDir, 'demo-pipeline.json'),
      JSON.stringify({ pipeline_id: 'demo-pipeline', steps: [] })
    );
    safeWriteFile(
      path.join(pipelinesDir, 'tenant-scope-test.json'),
      JSON.stringify({
        pipeline_id: 'tenant-scope-test',
        schedule: { id: 'tenant-scope-hourly', cron: '0 * * * *' },
        steps: [],
      })
    );
    safeWriteFile(
      path.join(pipelinesDir, 'window-excluded-test.json'),
      JSON.stringify({
        pipeline_id: 'window-excluded-test',
        schedule: { id: 'off', cron: '0 * * * *', enabled: false },
        steps: [],
      })
    );

    safeWriteFile(
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

    safeWriteFile(
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
    if (fixtureRoot && safeExistsSync(fixtureRoot)) {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
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

      it('keeps the tenant-less ad-hoc ledger and unhandled-intent sources out of a tenant harvest', () => {
        const unscopedKinds = (signals: DemandSignal[]) =>
          signals.filter((s) => s.kind === 'adhoc_pipeline' || s.kind === 'unhandled_intent');
        const tenant = collectKyberionDemandSignals({
          rootDir: fixtureRoot,
          now: NOW,
          tenantSlug: 'tenant-a',
        });
        expect(unscopedKinds(tenant)).toEqual([]);

        const personal = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
        expect(
          unscopedKinds(personal)
            .map((s) => s.signature)
            .sort()
        ).toEqual([
          'adhoc_pipeline:pipelines/bar-adhoc.json',
          'adhoc_pipeline:pipelines/foo-adhoc.json',
          'intent:rotate-secret',
        ]);

        const optedIn = collectKyberionDemandSignals({
          rootDir: fixtureRoot,
          now: NOW,
          tenantSlug: 'tenant-a',
          includeUnscoped: true,
        });
        expect(unscopedKinds(optedIn)).toHaveLength(3);
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

    it('marks each signal with its origin from pipelines/<id>.json and the source kind', () => {
      const signals = collectKyberionDemandSignals({
        rootDir: fixtureRoot,
        now: NOW,
        since: new Date('2026-01-01T00:00:00.000Z'),
        tenantSlug: 'tenant-a',
        includeUnscoped: true,
      });
      const origin = (signature: string) => signals.find((s) => s.signature === signature)?.origin;
      expect(origin('pipeline:demo-pipeline')).toBe('on_demand');
      expect(origin('pipeline:tenant-scope-test')).toBe('scheduled');
      expect(origin('pipeline:window-excluded-test')).toBe('on_demand'); // schedule disabled
      expect(origin('browser-pipeline:browser-test')).toBe('unknown'); // no pipeline file
      expect(origin('voice-actuator:speak_local')).toBe('unknown');
      expect(origin('mission_run')).toBe('unknown');
      expect(origin('adhoc_pipeline:pipelines/foo-adhoc.json')).toBe('on_demand');
      expect(origin('intent:rotate-secret')).toBe('on_demand');
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

    it('never matches an inferred (taxonomy-default) actuator binding', () => {
      const generic: DemandSignal = {
        ...signals[1],
        signature: 'browser-actuator:computer_interaction',
      };
      // applyClassification fills operate -> browser-actuator:computer_interaction as a hint.
      const classified = applyClassification(
        createWorkInventoryEntry(
          {
            title: 'entry inferred',
            scope: {},
            trigger: { kind: 'ad_hoc', description: 'test' },
            steps: [step({ verb: 'operate' })],
          },
          NOW
        )
      );
      expect(classified.steps[0].binding).toMatchObject({
        actuator: 'browser-actuator',
        op: 'computer_interaction',
        inferred: true,
      });
      expect(matchSignalsToEntries([classified], [generic]).has(classified.entry_id)).toBe(false);

      // An inferred actuator next to an explicit pipeline_id still matches on the pipeline.
      const withPipeline = applyClassification(
        createWorkInventoryEntry(
          {
            title: 'entry inferred with pipeline',
            scope: {},
            trigger: { kind: 'ad_hoc', description: 'test' },
            steps: [step({ verb: 'operate', binding: { pipeline_id: 'demo-pipeline' } })],
          },
          NOW
        )
      );
      expect(withPipeline.steps[0].binding?.inferred).toBe(true);
      expect(
        matchSignalsToEntries([withPipeline], [...signals, generic])
          .get(withPipeline.entry_id)
          ?.map((s) => s.signature)
      ).toEqual(['pipeline:demo-pipeline']);
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
      expect(updated.observations?.[0].digest).toContain('origin unknown');
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

    it('stamps a signal-derived binding inferred: false even when it equals the verb default', () => {
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
      expect(draft.steps[0].binding?.inferred).toBe(false);
      // Even with a pre-cutoff created_at, migration must leave it alone.
      const legacy = { ...draft, created_at: '2026-09-01T00:00:00.000Z' };
      expect(migrateInferredBindings(legacy).changed).toBe(0);
      // And it still counts as demand-signal evidence.
      expect(matchSignalsToEntries([draft], [meetingSignal]).get(draft.entry_id)).toHaveLength(1);
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

    it('skips scheduled signals by default and drafts them with includeScheduled', () => {
      const scheduled: DemandSignal = {
        signature: 'pipeline:baseline-check',
        kind: 'pipeline',
        count: 600,
        first_at: '2026-08-25T00:00:00.000Z',
        last_at: '2026-09-21T00:00:00.000Z',
        per_week: 168,
        failure_count: 0,
        window_days: 28,
        sample_refs: [],
        origin: 'scheduled',
      };
      const onDemand: DemandSignal = { ...signals[0], origin: 'on_demand' };
      const byDefault = suggestEntriesFromSignals([scheduled, onDemand], [], { now: NOW });
      expect(byDefault.map((d) => d.observations?.[0]?.ref)).toEqual(['pipeline:demo-pipeline']);
      expect(byDefault[0].observations?.[0].digest).toContain('origin on_demand');
      expect(byDefault[0].observations?.[0].origin).toBe('on_demand');

      const included = suggestEntriesFromSignals([scheduled, onDemand], [], {
        now: NOW,
        includeScheduled: true,
      });
      expect(included.map((d) => d.observations?.[0]?.ref).sort()).toEqual([
        'pipeline:baseline-check',
        'pipeline:demo-pipeline',
      ]);
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

// ---------------------------------------------------------------------------
// WI-13: trace-origin hygiene (test/ci exclusion, scheduled override, stats)
// ---------------------------------------------------------------------------
// A dedicated, minimal fixture — kept separate from the large shared fixture
// above so origin-related counts stay simple and self-evident rather than
// riding on unrelated bookkeeping/tenant/window fixture data.
describe('WI-13: trace origin hygiene', () => {
  let fixtureRoot = '';
  let tracesDir = '';

  beforeEach(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `work-inventory-harvest-origin-test-${randomUUID()}`
    );
    tracesDir = path.join(fixtureRoot, 'active', 'shared', 'logs', 'traces');
    safeMkdir(tracesDir, { recursive: true });

    const lines: string[] = [
      // pipeline:demo — 2 untagged (legacy) + 2 test + 1 ci. Only the 2
      // untagged traces ever reach the signal; the 3 test/ci traces are
      // excluded entirely (never touch any accumulator).
      traceLine({
        traceId: 'origin-demo-untagged-1',
        name: 'pipeline:demo',
        startedAt: '2026-09-19T01:00:00.000Z',
      }),
      traceLine({
        traceId: 'origin-demo-untagged-2',
        name: 'pipeline:demo',
        startedAt: '2026-09-19T02:00:00.000Z',
      }),
      traceLine({
        traceId: 'origin-demo-test-1',
        name: 'pipeline:demo',
        startedAt: '2026-09-19T03:00:00.000Z',
        origin: 'test',
      }),
      traceLine({
        traceId: 'origin-demo-test-2',
        name: 'pipeline:demo',
        startedAt: '2026-09-19T04:00:00.000Z',
        origin: 'test',
      }),
      traceLine({
        traceId: 'origin-demo-ci-1',
        name: 'pipeline:demo',
        startedAt: '2026-09-19T05:00:00.000Z',
        origin: 'ci',
      }),
      // voice-actuator:speak_local (actuator_op, no pipelines/<id>.json —
      // never resolves to 'scheduled' via the per-kind lookup) — 3 traces
      // tagged scheduled + 1 untagged. The signal still ends up 'scheduled'.
      traceLine({
        traceId: 'origin-voice-scheduled-1',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-19T06:00:00.000Z',
        origin: 'scheduled',
      }),
      traceLine({
        traceId: 'origin-voice-scheduled-2',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-19T07:00:00.000Z',
        origin: 'scheduled',
      }),
      traceLine({
        traceId: 'origin-voice-scheduled-3',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-19T08:00:00.000Z',
        origin: 'scheduled',
      }),
      traceLine({
        traceId: 'origin-voice-untagged',
        name: 'voice-actuator:speak_local',
        startedAt: '2026-09-19T09:00:00.000Z',
      }),
      // voice-actuator:transcribe — 1 scheduled among 3 counted traces: a
      // minority, so the signal must NOT become 'scheduled'.
      traceLine({
        traceId: 'origin-transcribe-scheduled',
        name: 'voice-actuator:transcribe',
        startedAt: '2026-09-19T06:30:00.000Z',
        origin: 'scheduled',
      }),
      traceLine({
        traceId: 'origin-transcribe-interactive-1',
        name: 'voice-actuator:transcribe',
        startedAt: '2026-09-19T07:30:00.000Z',
        origin: 'interactive',
      }),
      traceLine({
        traceId: 'origin-transcribe-interactive-2',
        name: 'voice-actuator:transcribe',
        startedAt: '2026-09-19T08:30:00.000Z',
        origin: 'interactive',
      }),
      // agent/interactive traces count normally and are neither excluded
      // nor tallied as untagged.
      traceLine({
        traceId: 'origin-agent-1',
        name: 'mission_run',
        startedAt: '2026-09-19T10:00:00.000Z',
        origin: 'agent',
      }),
      traceLine({
        traceId: 'origin-interactive-1',
        name: 'mission_run',
        startedAt: '2026-09-19T11:00:00.000Z',
        origin: 'interactive',
      }),
    ];
    safeWriteFile(path.join(tracesDir, 'traces-2026-09-19.jsonl'), lines.join('\n'));
  });

  afterEach(() => {
    if (fixtureRoot && safeExistsSync(fixtureRoot)) {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
    fixtureRoot = '';
  });

  it('drops test/ci traces entirely — they never become or grow a signal', () => {
    const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
    const demo = signals.find((s) => s.signature === 'pipeline:demo');
    expect(demo?.count).toBe(2);
    expect(demo?.sample_refs.sort()).toEqual(['origin-demo-untagged-1', 'origin-demo-untagged-2']);
  });

  it('marks a signal scheduled from trace-level metadata even for a non-pipeline (actuator_op) signature', () => {
    const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
    const voice = signals.find((s) => s.signature === 'voice-actuator:speak_local');
    expect(voice?.count).toBe(4); // 3 scheduled + 1 untagged, all counted
    expect(voice?.origin).toBe('scheduled');
  });

  it('does not mark a signal scheduled when scheduled traces are a minority of its counted traces', () => {
    const signals = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
    const transcribe = signals.find((s) => s.signature === 'voice-actuator:transcribe');
    expect(transcribe?.count).toBe(3);
    expect(transcribe?.origin).not.toBe('scheduled');
  });

  it('counts agent/interactive traces normally, neither excluded nor untagged', () => {
    const { signals, stats } = collectKyberionDemandSignalsWithStats({
      rootDir: fixtureRoot,
      now: NOW,
    });
    const missionRun = signals.find((s) => s.signature === 'mission_run');
    expect(missionRun?.count).toBe(2);
    expect(stats.excluded_test_or_ci).toBe(3);
    expect(stats.untagged).toBe(3); // 2 pipeline:demo + 1 voice-actuator, untagged
  });

  it('collectKyberionDemandSignals (the plain wrapper) returns the same signals as the stats variant', () => {
    const plain = collectKyberionDemandSignals({ rootDir: fixtureRoot, now: NOW });
    const { signals } = collectKyberionDemandSignalsWithStats({ rootDir: fixtureRoot, now: NOW });
    expect(plain).toEqual(signals);
  });
});
