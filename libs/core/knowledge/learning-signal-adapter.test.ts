import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueSignal = vi.hoisted(() =>
  vi.fn((signal: { signalId: string }) => `ops-${signal.signalId}`)
);
const persistHints = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ tenantSlug: undefined as string | undefined }));
const OWNER_AGENT = 'kyberion://agent/_/_/owner-agent';
const owner = vi.hoisted(() => ({
  scopeNhi: undefined as string | undefined,
  actor: undefined as unknown,
  installed: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('../core.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('./operational-learning.js', () => ({ enqueueOperationalLearningSignal: enqueueSignal }));
vi.mock('./feedback-loop.js', () => ({ persistHints }));
vi.mock('../authority.js', () => ({ resolveIdentityContext: () => identity }));
vi.mock('../scope-context.js', () => ({
  resolveScopeResolution: () => ({ scope: { nhi_id: owner.scopeNhi } }),
}));
vi.mock('../authn/actor-context.js', () => ({ currentActor: () => owner.actor }));
vi.mock('../organization/personal-runtime-identity.js', () => ({
  inspectInstalledPersonalRuntime: owner.installed,
}));
vi.mock('../daemon/ops-alert.js', () => ({ sendOpsAlert: owner.alert }));

import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import {
  closedToken,
  daysInWindow,
  errorCode,
  harvestLearningSignals,
  learningHarvestStatePath,
  resolveHarvestOwnerNhi,
  shouldProposeCluster,
  type LearningObservation,
  type LearningSignalSource,
} from './learning-signal-adapter.js';

interface PersistedState {
  cursors: Array<[string, string]>;
  clusters: Array<{ source: string; key: string; total: number }>;
  seen: Array<[string, Array<[string, string]>]>;
}

function readState(statePath: string): PersistedState | null {
  return readJsonIfPresent<PersistedState>(statePath);
}

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
    owner.scopeNhi = undefined;
    owner.actor = undefined;
    owner.alert.mockReset();
    owner.installed.mockReset();
    owner.installed.mockReturnValue({
      ready: true,
      ownerId: 'user:owner',
      agentId: OWNER_AGENT,
      agentActive: true,
      scope: { kind: 'person' },
    });
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
      { now: hours(5), ownerNhi: OWNER_AGENT }
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

  it('counts an ongoing finding once while it keeps being re-reported', () => {
    // Like runtime health: hourly samples, one ref per day, timestamp = latest sample,
    // harvested half an hour after each sample and once more in between.
    let latest = hours(1);
    const src = source(() => [obs('trend', latest, { ref: 'trend:day-1' })], { minOccurrences: 1 });
    harvest([src], hours(1.5));
    for (const at of [1.75, 2.5, 3.5, 4.5]) {
      latest = hours(Math.floor(at));
      const run = harvest([src], hours(at));
      expect(run.sources[0].observed).toBe(0);
    }
    const state = readState(learningHarvestStatePath(stateRoot));
    expect(state?.clusters.find((cluster) => cluster.key === 'trend')?.total).toBe(1);
  });

  it('forgets a ref once its source stops reporting it', () => {
    let rows = [obs('a', hours(1))];
    const src = source(() => rows);
    harvest([src], hours(1.05));
    rows = [];
    harvest([src], hours(2));
    const state = readState(learningHarvestStatePath(stateRoot));
    expect(state?.seen).toEqual([['test-source', []]]);
  });

  it('keeps record-derived keys as data, never as prototype properties', () => {
    const rows = [
      obs('__proto__', hours(1), { ref: '__proto__' }),
      obs('constructor', hours(1), { ref: 'constructor' }),
    ];
    harvest([source(() => rows, { id: '__proto__', minOccurrences: 1 })], hours(2));
    harvest([source(() => rows, { id: '__proto__', minOccurrences: 1 })], hours(3));
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.keys(Object.prototype)).toEqual([]);
    // The state survives a reload: the second harvest saw both refs as already counted.
    const state = readState(learningHarvestStatePath(stateRoot));
    expect(state?.clusters.map((cluster) => [cluster.source, cluster.key, cluster.total])).toEqual([
      ['__proto__', '__proto__', 1],
      ['__proto__', 'constructor', 1],
    ]);
    expect(state?.cursors.map(([id]) => id)).toEqual(['__proto__']);
  });

  it('falls back to the lookback when a stored cursor is unreadable', () => {
    harvest([source(() => [])], hours(1));
    const statePath = learningHarvestStatePath(stateRoot);
    const state = readState(statePath)!;
    writeJson(statePath, { ...state, cursors: [['test-source', 'not-a-date']] });
    const run = harvest([source(() => [obs('a', hours(1.5))], { minOccurrences: 1 })], hours(2));
    expect(run.signals).toBe(1);
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
    expect(tenant.scopes).toEqual(['acme']);
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
    const cursors = new Map(readState(learningHarvestStatePath(stateRoot))?.cursors);
    expect(cursors.has('broken')).toBe(false);
    expect(cursors.get('healthy')).toBe(hours(2).toISOString());
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

  it('maps errors onto closed codes and free text onto a fallback token', () => {
    expect(errorCode('[POLICY_VIOLATION] tenant acme')).toBe('POLICY_VIOLATION');
    expect(errorCode('ENOENT: knowledge/confidential/acme/x.md')).toBe('ENOENT');
    expect(errorCode('Timeout 30000ms exceeded')).toBe('timeout');
    expect(errorCode('ACME: sync failed')).toBe('error');
    expect(errorCode('EACMEX quota')).toBe('error');
    expect(errorCode('[ACME] failed')).toBe('error');
    expect(errorCode('429 Too Many Requests')).toBe('http_429');
    expect(errorCode("Customer 'acme' quota exceeded")).toBe('error');
    expect(closedToken('browser:click')).toBe('browser:click');
    expect(closedToken('write /repo/knowledge/x.md')).toBe('other');
    expect(closedToken('Acme Corp board deck')).toBe('other');
    expect(closedToken('acme.example.com')).toBe('other');
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

describe('learning-signal adapter personal owner', () => {
  let stateRoot: string;
  const rows = [obs('a', hours(1)), obs('a', hours(2)), obs('a', hours(3))];

  beforeEach(() => {
    enqueueSignal.mockClear();
    enqueueSignal.mockImplementation((signal: { signalId: string }) => `ops-${signal.signalId}`);
    persistHints.mockClear();
    identity.tenantSlug = undefined;
    owner.scopeNhi = undefined;
    owner.actor = undefined;
    owner.alert.mockReset();
    owner.installed.mockReset();
    stateRoot = pathResolver.sharedTmp(
      `learning-signal-owner-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
  });

  afterEach(() => {
    if (safeExistsSync(stateRoot)) safeRmSync(stateRoot, { recursive: true, force: true });
  });

  const harvest = (now: Date, extra: LearningObservation[] = []) =>
    harvestLearningSignals({ sources: [source(() => [...rows, ...extra])], now, stateRoot });
  const ready = () =>
    owner.installed.mockReturnValue({
      ready: true,
      ownerId: 'user:owner',
      agentId: OWNER_AGENT,
      agentActive: true,
      scope: { kind: 'person' },
    });

  it("prefers the producer's own nhi_id over the installed runtime", () => {
    owner.scopeNhi = 'kyberion://agent/_/_/producer';
    expect(resolveHarvestOwnerNhi()).toBe('kyberion://agent/_/_/producer');
    expect(owner.installed).not.toHaveBeenCalled();
  });

  it('uses the installed runtime only for an active agent of a standalone run', () => {
    ready();
    expect(resolveHarvestOwnerNhi()).toBe(OWNER_AGENT);
    owner.installed.mockReturnValue({ ...owner.installed(), agentActive: false });
    expect(resolveHarvestOwnerNhi()).toBeUndefined();
    owner.installed.mockReturnValue({ ready: false, reason: 'operator_identity_required' });
    expect(resolveHarvestOwnerNhi()).toBeUndefined();
    ready();
    owner.actor = { actorId: 'someone' };
    expect(resolveHarvestOwnerNhi()).toBeUndefined();
  });

  it('keeps a cluster unsignaled without an owner and proposes it once one exists', () => {
    owner.installed.mockReturnValue({ ready: false, reason: 'operator_identity_required' });
    const first = harvest(hours(4));
    expect(first.signals).toBe(0);
    expect(first.sources[0].skipped_owner).toBe(1);
    expect(enqueueSignal).not.toHaveBeenCalled();
    expect(persistHints).not.toHaveBeenCalled();
    expect(owner.alert).toHaveBeenCalledTimes(1);
    expect(owner.alert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: 'learning-signal-harvest:personal-owner-missing' })
    );

    // The next occurrence touches the cluster again; now it has an owner.
    ready();
    const second = harvest(hours(5), [obs('a', hours(4.5))]);
    expect(second.signals).toBe(1);
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'runtime_signal' }),
      {
        now: hours(5),
        ownerNhi: OWNER_AGENT,
      }
    );
  });

  it('reports a waiting cluster once across harvests, not on every run', () => {
    owner.installed.mockReturnValue({ ready: false, reason: 'operator_identity_required' });
    harvest(hours(4));
    // Same records again, then a recurrence: still waiting, no new alert.
    const again = harvest(hours(5));
    const recurred = harvest(hours(6), [obs('a', hours(5.5))]);
    expect(recurred.sources[0].skipped_owner).toBe(1);
    expect(again.signals + recurred.signals).toBe(0);
    expect(owner.alert).toHaveBeenCalledTimes(1);
    expect(enqueueSignal).not.toHaveBeenCalled();
  });

  it('proposes a waiting cluster once an owner exists, even without a recurrence', () => {
    owner.installed.mockReturnValue({ ready: false, reason: 'operator_identity_required' });
    harvest(hours(4));
    expect(enqueueSignal).not.toHaveBeenCalled();

    ready();
    const later = harvest(hours(8));
    expect(later.signals).toBe(1);
    expect(enqueueSignal).toHaveBeenCalledTimes(1);
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'runtime_signal' }),
      {
        now: hours(8),
        ownerNhi: OWNER_AGENT,
      }
    );
    // Signaled: the next harvest neither re-proposes nor alerts.
    const after = harvest(hours(9));
    expect(after.signals).toBe(0);
    expect(enqueueSignal).toHaveBeenCalledTimes(1);
    expect(owner.alert).toHaveBeenCalledTimes(1);
  });

  it('never needs a personal owner for a tenant cluster', () => {
    identity.tenantSlug = 'acme';
    const tenantRows = rows.map((row) => ({ ...row, tenantSlug: 'acme' }));
    const report = harvestLearningSignals({
      sources: [source(() => tenantRows)],
      now: hours(4),
      stateRoot,
    });
    expect(report.signals).toBe(1);
    expect(owner.installed).not.toHaveBeenCalled();
    expect(enqueueSignal).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'confidential', tenantSlug: 'acme' }),
      { now: hours(4) }
    );
  });
});
