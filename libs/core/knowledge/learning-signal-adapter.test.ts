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
  closedToken,
  daysInWindow,
  errorClass,
  errorCode,
  harvestLearningSignals,
  learningHarvestStatePath,
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
  let stateRoot: string;

  beforeEach(() => {
    enqueueSignal.mockClear();
    enqueueSignal.mockImplementation((signal: { signalId: string }) => `ops-${signal.signalId}`);
    persistHints.mockClear();
    identity.tenantSlug = undefined;
    stateRoot = pathResolver.sharedTmp(
      `learning-signal-adapter-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
  });

  afterEach(() => {
    if (safeExistsSync(stateRoot)) safeRmSync(stateRoot, { recursive: true, force: true });
  });

  const harvest = (sources: LearningSignalSource[], now: Date, extra = {}) =>
    harvestLearningSignals({ sources, now, stateRoot, ...extra });

  it('accumulates a cluster across harvests and proposes it once it recurs', () => {
    let rows: LearningObservation[] = [obs('a', hours(1)), obs('a', hours(2))];
    const src = source(() => rows);

    const first = harvest([src], hours(3));
    expect(first.sources[0].proposed).toEqual([]);
    expect(enqueueSignal).not.toHaveBeenCalled();

    rows = [...rows, obs('a', hours(4))];
    const second = harvest([src], hours(5));
    expect(second.signals).toBe(1);
    expect(second.sources[0].proposed[0]).toMatchObject({ key: 'a', total: 3, new_count: 1 });
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signalId: expect.stringMatching(/^test-source-[0-9a-f]{10}-x3$/),
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

  it('counts a record once even when the overlap re-reads it', () => {
    const rows = [obs('a', hours(1)), obs('a', hours(2)), obs('a', hours(3))];
    const src = source(() => rows);
    harvest([src], hours(3));
    enqueueSignal.mockClear();

    const again = harvest([src], hours(3.05));
    expect(again.sources[0].observed).toBe(0);
    expect(enqueueSignal).not.toHaveBeenCalled();
  });

  it('counts a record appended after a harvest with an earlier timestamp', () => {
    const rows = [obs('a', hours(1)), obs('a', hours(2))];
    const src = source(() => rows);
    harvest([src], hours(3));
    // Written at 2:59:30 but appended after the 3:00 harvest read the log.
    rows.push(obs('a', new Date(hours(3).getTime() - 30_000)));
    const late = harvest([src], hours(4));
    expect(late.sources[0].observed).toBe(1);
    expect(late.signals).toBe(1);
  });

  it('re-proposes a cluster only after its total doubles', () => {
    expect(shouldProposeCluster(2, 0, 3)).toBe(false);
    expect(shouldProposeCluster(3, 0, 3)).toBe(true);
    expect(shouldProposeCluster(5, 3, 3)).toBe(false);
    expect(shouldProposeCluster(6, 3, 3)).toBe(true);
  });

  it('retries the proposal when the learning queue refused it', () => {
    const rows = [obs('a', hours(1))];
    const src = source(() => rows, { minOccurrences: 1 });
    enqueueSignal.mockImplementationOnce(() => null as never);
    const refused = harvest([src], hours(2));
    expect(refused.signals).toBe(0);
    expect(persistHints).not.toHaveBeenCalled();

    rows.push(obs('a', hours(3)));
    const retried = harvest([src], hours(4));
    expect(retried.signals).toBe(1);
  });

  it('leaves another tenant unread until a harvest runs inside that tenant', () => {
    const rows = [
      obs('t', hours(1), { tenantSlug: 'acme' }),
      obs('t', hours(1.5), { tenantSlug: 'acme' }),
    ];
    const src = source(() => rows, { minOccurrences: 2 });

    const platform = harvest([src], hours(2));
    expect(platform.sources[0].skipped_scope).toBe(2);
    expect(enqueueSignal).not.toHaveBeenCalled();

    identity.tenantSlug = 'acme';
    const tenant = harvest([src], hours(3));
    expect(tenant.scopes).toEqual(['system', 'acme']);
    expect(tenant.signals).toBe(1);
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'confidential', tenantSlug: 'acme' }),
      expect.anything()
    );
    expect(persistHints).not.toHaveBeenCalled();
    expect(safeExistsSync(learningHarvestStatePath(stateRoot, 'acme'))).toBe(true);
    expect(learningHarvestStatePath(stateRoot, 'acme')).toContain(
      path.join('confidential', 'acme', 'harvest-state.json')
    );
    const platformState = readJsonIfPresent<{ clusters: Record<string, unknown> }>(
      learningHarvestStatePath(stateRoot)
    );
    expect(JSON.stringify(platformState)).not.toContain('acme');
  });

  it('reports a failing source, keeps its cursor, and still harvests the others', () => {
    const broken = source(
      () => {
        throw new Error('log unreadable');
      },
      { id: 'broken' }
    );
    const healthy = source(() => [obs('x', hours(1))], { id: 'healthy', minOccurrences: 1 });
    const report = harvest([broken, healthy], hours(2));

    expect(report.sources[0].error).toBe('log unreadable');
    expect(report.sources[1].signal_ids).toHaveLength(1);
    const state = readJsonIfPresent<{ cursors: Record<string, string> }>(
      learningHarvestStatePath(stateRoot)
    );
    expect(state?.cursors.broken).toBeUndefined();
    expect(state?.cursors.healthy).toBe(hours(2).toISOString());
  });

  it('writes nothing on a dry run', () => {
    const report = harvest([source(() => [obs('a', hours(1))], { minOccurrences: 1 })], hours(2), {
      dryRun: true,
    });
    expect(report.sources[0].proposed).toHaveLength(1);
    expect(enqueueSignal).not.toHaveBeenCalled();
    expect(persistHints).not.toHaveBeenCalled();
    expect(safeExistsSync(learningHarvestStatePath(stateRoot))).toBe(false);
  });

  it('collapses error messages into structural classes without values or paths', () => {
    expect(errorClass('ENOENT: no such file /home/u/x.json')).toBe('ENOENT: no such file <path>');
    expect(errorClass('[POLICY_VIOLATION] request 1234 failed')).toBe(
      'POLICY_VIOLATION request <n> failed'
    );
    expect(errorClass('steps/3/op: must be string; name: required')).toBe(
      'steps/<n>/op: must be string'
    );
    expect(errorClass('not found in knowledge/confidential/acme/x.md')).toBe('not found in <path>');
    expect(errorClass("Customer 'acme' quota exceeded")).toBe('Customer <value> quota exceeded');
    expect(errorClass('trace a1b2c3d4e5f6 aborted')).toBe('trace <id> aborted');
  });

  it('maps errors onto closed codes and free text onto a fallback token', () => {
    expect(errorCode('[POLICY_VIOLATION] tenant acme')).toBe('POLICY_VIOLATION');
    expect(errorCode('ENOENT: knowledge/confidential/acme/x.md')).toBe('ENOENT');
    expect(errorCode('Timeout 30000ms exceeded')).toBe('timeout');
    expect(errorCode('429 Too Many Requests')).toBe('http_429');
    expect(errorCode("Customer 'acme' quota exceeded")).toBe('error');
    expect(closedToken('browser:click')).toBe('browser:click');
    expect(closedToken('write /repo/knowledge/x.md')).toBe('other');
    expect(closedToken('Acme Corp board deck')).toBe('other');
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
