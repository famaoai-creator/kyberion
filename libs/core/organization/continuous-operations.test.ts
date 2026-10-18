import { describe, expect, it, vi } from 'vitest';
import {
  runContinuousOperations,
  CONTINUOUS_SOURCE_MAX_BYTES,
  CONTINUOUS_STATE_MAX_BYTES,
  type ContinuousOperationsDeps,
} from './continuous-operations.js';
import { DOT_FLOOR_CONTRIBUTORS, DOT_PRE_GATE_CHECKS } from '../dot/dot-extension-registry.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotDispatchResult } from '../dot/dot-dispatch.js';
import { dotDelegationCapacity } from '../dot/dot-dispatch.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFileSnapshot, safeWriteFile, safeRmSync } from '../secure-io.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const now = new Date('2026-10-18T01:00:00.000Z');
const config = {
  version: '1',
  loop_id: 'quality',
  dot_id: 'operator',
  enabled: true,
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org' },
  sources: [
    {
      source_id: 'quality',
      path: 'active/shared/runtime/confidential/acme/metrics.json',
      max_age_seconds: 1000000,
    },
  ],
  rules: [
    {
      rule_id: 'errors',
      source_id: 'quality',
      metric: 'errors',
      operator: 'gt',
      threshold: 5,
      objective_ref: 'quality',
      title: 'Investigate',
      objective: 'Reduce errors',
      pipeline_ref: 'pipelines/quality.json',
    },
  ],
  max_proposals_per_run: 2,
  cooldown_seconds: 60,
};
const charter = {
  dot_id: 'operator',
  status: 'active',
  scope: config.scope,
  authority: { authority_role: 'organization_operator' },
} as DotCharter;
function fixture() {
  const files = new Map<string, unknown>();
  let value = 10;
  let observedAt = now.toISOString();
  const dispatch = vi.fn(
    () =>
      ({
        records: [{ status: 'dispatched', action_ref: 'action', work_item_id: 'work' }],
        duplicates: [],
      }) as unknown as DotDispatchResult
  );
  const write = vi.fn((file: string, data: unknown) => files.set(file, structuredClone(data)));
  const deps: ContinuousOperationsDeps = {
    charters: () => [charter],
    authorize: () => undefined,
    lock: (_key, fn) => fn(),
    read: (file) =>
      file.endsWith('metrics.json')
        ? [{ metric: 'errors', value, observed_at: observedAt, evidence_ref: 'metric:errors' }]
        : structuredClone(files.get(file)),
    exists: (file) => files.has(file),
    write,
    dispatch,
  };
  const run = (apply = true, at = now) =>
    runContinuousOperations(config, { apply, now: at, rootDir: '/test' }, deps);
  return {
    files,
    deps,
    dispatch,
    write,
    run,
    setValue: (next: number) => {
      value = next;
    },
    setTime: (next: string) => {
      observedAt = next;
    },
  };
}
describe('continuous operations runtime', () => {
  it('keeps admitted work observable after recovery without mislabeling a new episode', () => {
    const f = fixture();
    f.run();
    f.setValue(0);
    expect(f.run().inventory[0]).toMatchObject({
      disposition: 'recovered',
      action_ref: 'action',
      work_item_id: 'work',
    });
    expect(f.run().inventory[0]).toMatchObject({
      disposition: 'not_triggered',
      action_ref: 'action',
      work_item_id: 'work',
    });
    f.setValue(10);
    const recurrence = f.run();
    expect(recurrence.inventory[0].disposition).toBe('cooldown');
    expect(recurrence.inventory[0].action_ref).toBeUndefined();
    f.deps.capacity = () => ({ cap: 1, open: 1, free: 0 });
    const limited = f.run(true, new Date(now.getTime() + 60000));
    expect(limited.inventory[0].disposition).toBe('limited');
    expect(limited.inventory[0].action_ref).toBeUndefined();
  });
  it('does not retain an old action reference when a recurrent new admission fails', () => {
    const f = fixture();
    f.run();
    f.setValue(0);
    f.run();
    f.setValue(10);
    f.dispatch.mockImplementationOnce(() => {
      throw new Error('new admission failed');
    });
    const report = f.run(true, new Date(now.getTime() + 60000));
    expect(report.inventory[0].disposition).toBe('error');
    const state = [...f.files.values()][0] as {
      rules: Record<string, { action_ref?: string; work_item_id?: string }>;
    };
    expect(state.rules.errors.action_ref).toBeUndefined();
    expect(state.rules.errors.work_item_id).toBeUndefined();
  });
  it('uses the actual dot cap and open-count semantics for admission capacity', () => {
    const rootDir = pathResolver.sharedTmp(`vitest-continuous-capacity-${randomUUID()}`);
    const bounded = {
      ...charter,
      authority: { ...charter.authority, max_concurrent_delegations: 1 },
    };
    expect(dotDelegationCapacity(bounded, { rootDir, countOpenWorkItems: () => 2 })).toEqual({
      cap: 1,
      open: 2,
      free: 0,
    });
    expect(dotDelegationCapacity(bounded, { rootDir, countOpenWorkItems: () => 0 })).toEqual({
      cap: 1,
      open: 0,
      free: 1,
    });
  });
  it('waits without an admission identity at capacity and resumes when a slot is free', () => {
    const f = fixture();
    let free = 0;
    f.deps.capacity = vi.fn(() => ({ cap: 1, open: 1 - free, free }));
    expect(f.run().inventory[0]).toMatchObject({
      disposition: 'limited',
      reason: expect.stringContaining('capacity'),
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    const saved = [...f.files.values()][0] as { rules: Record<string, Record<string, unknown>> };
    expect(saved.rules.errors).toMatchObject({ generation: 0, healthy: true });
    expect(saved.rules.errors.operation_key).toBeUndefined();
    expect(saved.rules.errors.admitted_at).toBeUndefined();
    free = 1;
    expect(f.run().inventory[0].disposition).toBe('proposed');
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('re-reads capacity before each new candidate in the same cycle', () => {
    const f = fixture();
    let open = 0;
    f.deps.capacity = vi.fn(() => ({ cap: 1, open, free: Math.max(0, 1 - open) }));
    f.dispatch.mockImplementation(() => {
      open += 1;
      return {
        records: [{ status: 'dispatched', action_ref: 'action', work_item_id: 'work' }],
        duplicates: [],
      } as unknown as DotDispatchResult;
    });
    const report = runContinuousOperations(
      { ...config, rules: [config.rules[0], { ...config.rules[0], rule_id: 'second' }] },
      { apply: true, now, rootDir: '/test' },
      f.deps
    );
    expect(report.inventory.map((row) => row.disposition)).toEqual(['proposed', 'limited']);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.deps.capacity).toHaveBeenCalledTimes(2);
  });
  it('acknowledges explicit refusal recovery while preserving cooldown and capacity waiting', () => {
    const f = fixture();
    f.dispatch.mockReturnValueOnce({
      records: [{ status: 'refused', action_ref: 'refusal', reason: 'capacity race' }],
      duplicates: [],
    } as unknown as DotDispatchResult);
    f.run();
    let free = 0;
    f.deps.capacity = () => ({ cap: 1, open: 1 - free, free });
    const recover = runContinuousOperations(
      config,
      { apply: true, recoverAdmissions: true, now, rootDir: '/test' },
      f.deps
    );
    expect(recover.inventory[0].disposition).toBe('cooldown');
    expect(f.run().inventory[0].disposition).toBe('cooldown');
    const later = new Date(now.getTime() + 60000);
    expect(f.run(true, later).inventory[0].disposition).toBe('limited');
    expect(f.dispatch).toHaveBeenCalledOnce();
    free = 1;
    expect(f.run(true, later).inventory[0].disposition).toBe('proposed');
    const calls = f.dispatch.mock.calls as unknown[][];
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).not.toBe(calls[1][2]);
  });
  it('uses precollected observations without reading a source and validates before checkpointing', () => {
    const f = fixture();
    const read = vi.spyOn(f.deps, 'read');
    const input = {
      ...config,
      sources: [{ source_id: 'quality', kind: 'organization_metrics', max_age_seconds: 60 }],
    };
    const snapshots = [
      {
        source_id: 'quality',
        observations: [
          {
            metric: 'errors',
            value: 10,
            observed_at: now.toISOString(),
            evidence_ref: 'collected:quality',
          },
        ],
      },
    ];
    expect(
      runContinuousOperations(input, { apply: true, now, rootDir: '/test', snapshots }, f.deps)
        .inventory[0].disposition
    ).toBe('proposed');
    expect(read).not.toHaveBeenCalled();
    expect(() =>
      runContinuousOperations(input, { apply: true, now, rootDir: '/test', snapshots: [] }, f.deps)
    ).toThrow('incomplete sources');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(() => runContinuousOperations(input, { now, rootDir: '/test' }, f.deps)).toThrow(
      'async cycle collector'
    );
  });
  it('loads the budget and arbitration gates before default admission', () => {
    expect(DOT_FLOOR_CONTRIBUTORS.some((row) => row.id === 'budget-soft')).toBe(true);
    expect(DOT_PRE_GATE_CHECKS.length).toBeGreaterThan(0);
  });
  it('dry run has no side effects and reports a grounded candidate', () => {
    const f = fixture();
    expect(f.run(false).inventory[0]).toMatchObject({
      disposition: 'proposed',
      current_value: 10,
      evidence_refs: ['metric:errors'],
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('persists identity before admission and suppresses the same violation beyond 24 hours', () => {
    const f = fixture();
    f.dispatch.mockImplementation(() => {
      expect([...f.files.values()][0]).toMatchObject({
        rules: { errors: { status: 'admission_intent', generation: 1 } },
      });
      return {
        records: [{ status: 'parked', action_ref: 'approval' }],
        duplicates: [],
      } as unknown as DotDispatchResult;
    });
    expect(f.run().inventory[0].dot_status).toBe('parked');
    expect(f.run(true, new Date(now.getTime() + 86400000)).inventory[0]).toMatchObject({
      disposition: 'duplicate',
      dot_status: 'parked',
      delta: 0,
    });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('permits a new episode only after a healthy observation and cooldown', () => {
    const f = fixture();
    f.run();
    f.setValue(0);
    expect(f.run().inventory[0].disposition).toBe('recovered');
    f.setValue(10);
    expect(f.run().inventory[0].disposition).toBe('cooldown');
    expect(f.run(true, new Date(now.getTime() + 60000)).inventory[0].disposition).toBe('proposed');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[0]).not.toEqual(f.dispatch.mock.calls[1]);
  });
  it('replays the same operation identity after a dispatch failure', () => {
    const f = fixture();
    f.dispatch.mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    expect(f.run().inventory[0].disposition).toBe('error');
    expect(f.run().inventory[0].disposition).toBe('error');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(
      runContinuousOperations(
        config,
        { apply: true, recoverAdmissions: true, now, rootDir: '/test' },
        f.deps
      ).inventory[0].disposition
    ).toBe('recovered');
    const calls = f.dispatch.mock.calls as unknown[][];
    expect(calls[0][2]).toBe(calls[1][2]);
  });
  it('fails all source validation before checkpoints or admission', () => {
    const f = fixture();
    f.setTime('2020-01-01T00:00:00.000Z');
    expect(() => f.run()).toThrow(/stale/);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('fails closed on malformed durable state', () => {
    const f = fixture();
    const report = f.run(false);
    f.files.set(report.state_path, { version: 1 });
    expect(() => f.run()).toThrow(/state/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects mismatched or inactive charter scopes', () => {
    const f = fixture();
    f.deps.charters = () => [{ ...charter, scope: { ...charter.scope, project_id: 'other' } }];
    expect(() => f.run()).toThrow(/exact scope/);
    f.deps.charters = () => [{ ...charter, status: 'paused' } as DotCharter];
    expect(() => f.run()).toThrow(/active dot/);
  });
  it('does not read sources or durable state for a disabled loop', () => {
    const f = fixture();
    f.deps.read = () => {
      throw new Error('unexpected read');
    };
    expect(
      runContinuousOperations({ ...config, enabled: false }, { apply: true }, f.deps).inventory
    ).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not reuse an admission identity when rules change A to B to A', () => {
    const f = fixture();
    f.run();
    const run = (threshold: number, offset: number) =>
      runContinuousOperations(
        { ...config, rules: [{ ...config.rules[0], threshold }] },
        { apply: true, now: new Date(now.getTime() + offset), rootDir: '/test' },
        f.deps
      );
    run(6, 60000);
    run(5, 120000);
    const keys = (f.dispatch.mock.calls as unknown[][]).map((call) => call[2]);
    expect(new Set(keys).size).toBe(3);
  });
  it('starts a fresh episode when the configured collector changes, retaining cooldown', () => {
    const f = fixture();
    f.run();
    const input = {
      ...config,
      sources: [{ ...config.sources[0], kind: 'pipeline', pipeline_ref: 'pipelines/collect.json' }],
    };
    const snapshots = [
      {
        source_id: 'quality',
        observations: [
          {
            metric: 'errors',
            value: 9,
            observed_at: now.toISOString(),
            evidence_ref: 'collector:new',
          },
        ],
      },
    ];
    const run = (offset: number) =>
      runContinuousOperations(
        input,
        {
          apply: true,
          now: new Date(now.getTime() + offset),
          rootDir: '/test',
          snapshots,
        },
        f.deps
      );
    expect(run(0).inventory[0]).toMatchObject({
      disposition: 'cooldown',
      current_value: 9,
      evidence_refs: ['collector:new'],
    });
    expect(run(60000).inventory[0].disposition).toBe('proposed');
    const keys = (f.dispatch.mock.calls as unknown[][]).map((call) => call[2]);
    expect(new Set(keys).size).toBe(2);
  });
  it('handles rule ids that match inherited object properties', () => {
    const f = fixture();
    const input = { ...config, rules: [{ ...config.rules[0], rule_id: 'constructor' }] };
    expect(
      runContinuousOperations(input, { apply: true, now, rootDir: '/test' }, f.deps).inventory[0]
        .disposition
    ).toBe('proposed');
    expect(
      runContinuousOperations(input, { apply: true, now, rootDir: '/test' }, f.deps).inventory[0]
        .disposition
    ).toBe('duplicate');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps refusal explicit and requires manual recovery with a fresh identity', () => {
    const f = fixture();
    f.dispatch.mockImplementationOnce(
      () =>
        ({
          records: [{ status: 'refused', action_ref: 'refusal', reason: 'budget' }],
          duplicates: [],
        }) as unknown as DotDispatchResult
    );
    expect(f.run().inventory[0]).toMatchObject({
      disposition: 'error',
      dot_status: 'refused',
      error: 'budget',
    });
    expect(f.run().inventory[0]).toMatchObject({ disposition: 'error', dot_status: 'refused' });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    runContinuousOperations(
      config,
      {
        apply: true,
        recoverAdmissions: true,
        now: new Date(now.getTime() + 60000),
        rootDir: '/test',
      },
      f.deps
    );
    const calls = f.dispatch.mock.calls as unknown[][];
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).not.toBe(calls[1][2]);
  });
  it('enforces the production authority guard before reading any source', () => {
    const f = fixture();
    delete f.deps.authorize;
    const read = vi.fn(f.deps.read!);
    f.deps.read = read;
    expect(() => f.run()).toThrow(/execution scope/);
    expect(() =>
      withExecutionContext('organization_operator', () => f.run(), undefined, 'acme', 'other')
    ).toThrow(/organization/);
    expect(() =>
      withExecutionContext('organization_operator', () => f.run(), undefined, 'other', 'org')
    ).toThrow(/tenant/);
    expect(read).not.toHaveBeenCalled();
    expect(
      withExecutionContext('organization_operator', () => f.run(false), undefined, 'acme', 'org')
        .inventory[0].disposition
    ).toBe('proposed');
  });
  it('uses real secure IO and locks and deduplicates after reopening persisted state', () => {
    const rootDir = pathResolver.sharedTmp(`vitest-continuous-operations-${randomUUID()}`);
    const source = path.join(rootDir, config.sources[0].path);
    const f = fixture();
    try {
      safeWriteFile(
        source,
        JSON.stringify([
          {
            metric: 'errors',
            value: 10,
            observed_at: now.toISOString(),
            evidence_ref: 'real:errors',
          },
        ])
      );
      const deps = { charters: () => [charter], dispatch: f.dispatch };
      const run = () =>
        withExecutionContext(
          'organization_operator',
          () => runContinuousOperations(config, { apply: true, now, rootDir }, deps),
          undefined,
          'acme',
          'org'
        );
      const first = run();
      expect(first.inventory[0].dot_status).toBe('dispatched');
      expect(
        JSON.parse(safeReadFileSnapshot(first.state_path, 1048576).toString('utf8'))
      ).toMatchObject({ rules: { errors: { generation: 1, evidence_refs: ['real:errors'] } } });
      expect(run().inventory[0]).toMatchObject({
        disposition: 'duplicate',
        dot_status: 'dispatched',
      });
      expect(f.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
  it('roundtrips valid durable provenance larger than the source snapshot limit', () => {
    const rootDir = pathResolver.sharedTmp(`vitest-continuous-large-state-${randomUUID()}`);
    const input = {
      ...config,
      rules: Array.from({ length: 1000 }, (_, index) => ({
        ...config.rules[0],
        rule_id: `rule-${index}`,
        threshold: 100,
        objective_ref: 'o'.repeat(512),
      })),
    };
    const dispatch = vi.fn();
    try {
      safeWriteFile(
        path.join(rootDir, config.sources[0].path),
        JSON.stringify([
          {
            metric: 'errors',
            value: 0,
            observed_at: now.toISOString(),
            evidence_ref: 'e'.repeat(1024),
          },
        ])
      );
      const run = () =>
        withExecutionContext(
          'organization_operator',
          () =>
            runContinuousOperations(
              input,
              { apply: true, now, rootDir },
              { charters: () => [charter], dispatch }
            ),
          undefined,
          'acme',
          'org'
        );
      const first = run();
      expect(
        safeReadFileSnapshot(first.state_path, CONTINUOUS_STATE_MAX_BYTES).byteLength
      ).toBeGreaterThan(CONTINUOUS_SOURCE_MAX_BYTES);
      expect(run().inventory).toHaveLength(1000);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });
  it.each(['refused', 'admission_error', 'admission_intent'])(
    'opens a fresh episode after healthy recovery from %s',
    (status) => {
      const f = fixture();
      if (status === 'refused')
        f.dispatch.mockImplementationOnce(
          () =>
            ({
              records: [{ status: 'refused', action_ref: 'refused', reason: 'budget' }],
              duplicates: [],
            }) as unknown as DotDispatchResult
        );
      else
        f.dispatch.mockImplementationOnce(() => {
          throw new Error('interrupted');
        });
      const first = f.run();
      if (status === 'admission_intent') {
        const state = f.files.get(first.state_path) as {
          rules: Record<string, { status: string }>;
        };
        state.rules.errors.status = 'admission_intent';
      }
      f.setValue(0);
      expect(f.run().inventory[0].disposition).toBe('recovered');
      f.setValue(10);
      expect(f.run(true, new Date(now.getTime() + 60000)).inventory[0].disposition).toBe(
        'proposed'
      );
      const calls = f.dispatch.mock.calls as unknown[][];
      expect(calls).toHaveLength(2);
      expect(calls[0][2]).not.toBe(calls[1][2]);
    }
  );
});
