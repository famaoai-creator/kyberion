import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueSignal = vi.hoisted(() =>
  vi.fn((signal: { signalId: string }) => `ops-${signal.signalId}`)
);
const persistHints = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ tenantSlug: undefined as string | undefined }));

vi.mock('../core.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../operational-learning.js', () => ({ enqueueOperationalLearningSignal: enqueueSignal }));
vi.mock('./feedback-loop.js', () => ({ persistHints }));
vi.mock('../authority.js', () => ({ resolveIdentityContext: () => identity }));

import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { readJsonIfPresent } from '../foundation/json.js';
import {
  daysInWindow,
  errorClass,
  harvestLearningSignals,
  shouldProposeCluster,
  type LearningObservation,
  type LearningSignalSource,
} from './learning-signal-adapter.js';

const T0 = new Date('2026-10-01T00:00:00.000Z');
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

function source(
  rows: () => LearningObservation[],
  overrides: Partial<LearningSignalSource> = {}
): LearningSignalSource {
  return {
    id: 'test-source',
    description: 'A test log.',
    minOccurrences: 3,
    hintCategory: 'test-hints',
    read: () => rows(),
    ...overrides,
  };
}

function obs(key: string, at: Date, extra: Partial<LearningObservation> = {}): LearningObservation {
  return {
    key,
    title: `title ${key}`,
    ref: `ref-${key}-${at.toISOString()}`,
    ts: at.toISOString(),
    ...extra,
  };
}

describe('learning-signal adapter (LS-01)', () => {
  let statePath: string;

  beforeEach(() => {
    enqueueSignal.mockClear();
    persistHints.mockClear();
    identity.tenantSlug = undefined;
    statePath = path.join(
      pathResolver.sharedTmp(
        `learning-signal-adapter-test-${process.pid}-${Math.random().toString(36).slice(2)}`
      ),
      'state.json'
    );
  });

  afterEach(() => {
    const dir = path.dirname(statePath);
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('accumulates a cluster across harvests and proposes it once it recurs', () => {
    let rows: LearningObservation[] = [obs('a', hours(1)), obs('a', hours(2))];
    const src = source(() => rows);

    const first = harvestLearningSignals({ sources: [src], now: hours(3), statePath });
    expect(first.sources[0].proposed).toEqual([]);
    expect(enqueueSignal).not.toHaveBeenCalled();

    rows = [obs('a', hours(4))];
    const second = harvestLearningSignals({ sources: [src], now: hours(5), statePath });
    expect(second.signals).toBe(1);
    expect(second.sources[0].proposed[0]).toMatchObject({ key: 'a', total: 3, new_count: 1 });
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'runtime_signal',
        targetKind: 'knowledge_hint',
        sourceRef: 'learning-signal:test-source:a',
        metadata: expect.objectContaining({ signal_source: 'test-source', total: 3 }),
      }),
      { now: hours(5) }
    );
    expect(persistHints).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          topic: 'test-source:a',
          tags: ['learning_signal', 'test-source'],
        }),
      ],
      'test-hints'
    );
  });

  it('reads only records after the cursor of the previous harvest', () => {
    const rows = [obs('a', hours(1)), obs('a', hours(2)), obs('a', hours(3))];
    const src = source(() => rows);
    harvestLearningSignals({ sources: [src], now: hours(4), statePath });
    enqueueSignal.mockClear();

    const again = harvestLearningSignals({ sources: [src], now: hours(5), statePath });
    expect(again.sources[0].observed).toBe(0);
    expect(enqueueSignal).not.toHaveBeenCalled();
  });

  it('re-proposes a cluster only after its total doubles', () => {
    expect(shouldProposeCluster(2, 0, 3)).toBe(false);
    expect(shouldProposeCluster(3, 0, 3)).toBe(true);
    expect(shouldProposeCluster(5, 3, 3)).toBe(false);
    expect(shouldProposeCluster(6, 3, 3)).toBe(true);
  });

  it('keeps tenant observations inside the active tenant and never turns them into hints', () => {
    const rows = [
      obs('t', hours(1), { tenantSlug: 'acme' }),
      obs('other', hours(1), { tenantSlug: 'globex' }),
    ];
    identity.tenantSlug = 'acme';
    const report = harvestLearningSignals({
      sources: [source(() => rows, { minOccurrences: 1 })],
      now: hours(2),
      statePath,
    });

    expect(report.sources[0].skipped_scope).toBe(1);
    expect(enqueueSignal).toHaveBeenCalledTimes(1);
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'confidential', tenantSlug: 'acme' }),
      expect.anything()
    );
    expect(persistHints).not.toHaveBeenCalled();
  });

  it('reports a failing source, keeps its cursor, and still harvests the others', () => {
    const broken = source(
      () => {
        throw new Error('log unreadable');
      },
      { id: 'broken' }
    );
    const healthy = source(() => [obs('x', hours(1))], { id: 'healthy', minOccurrences: 1 });
    const report = harvestLearningSignals({ sources: [broken, healthy], now: hours(2), statePath });

    expect(report.sources[0].error).toBe('log unreadable');
    expect(report.sources[1].signal_ids).toHaveLength(1);
    const state = readJsonIfPresent<{ cursors: Record<string, string> }>(statePath);
    expect(state?.cursors.broken).toBeUndefined();
    expect(state?.cursors.healthy).toBe(hours(2).toISOString());
  });

  it('writes nothing on a dry run', () => {
    const report = harvestLearningSignals({
      sources: [source(() => [obs('a', hours(1))], { minOccurrences: 1 })],
      now: hours(2),
      statePath,
      dryRun: true,
    });
    expect(report.sources[0].proposed).toHaveLength(1);
    expect(enqueueSignal).not.toHaveBeenCalled();
    expect(persistHints).not.toHaveBeenCalled();
    expect(safeExistsSync(statePath)).toBe(false);
  });

  it('collapses error messages into structural classes', () => {
    expect(errorClass('ENOENT: no such file /home/u/x.json')).toBe('ENOENT: no such file <path>');
    expect(errorClass('[POLICY_VIOLATION] request 1234 failed')).toBe(
      'POLICY_VIOLATION request <n> failed'
    );
    expect(errorClass('steps/3/op: must be string; name: required')).toBe(
      'steps/<n>/op: must be string'
    );
    expect(errorClass('trace a1b2c3d4e5f6 aborted')).toBe('trace <id> aborted');
  });

  it('lists every UTC day a window touches', () => {
    expect(
      daysInWindow({
        since: new Date('2026-09-30T22:00:00Z'),
        until: new Date('2026-10-02T01:00:00Z'),
      })
    ).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});
