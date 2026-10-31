import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import type { ScopeContext } from '../scope-context-validation.js';
import {
  createJudgmentPrecedentSnapshot,
  judgmentCanonicalHash,
  type JudgmentPrecedentDeps,
  type JudgmentPrecedentResult,
} from './judgment-precedents.js';

const scope: ScopeContext = {
  tier: 'confidential',
  tenant_slug: 'synthetic-latency',
  organization_id: 'synthetic-org',
  project_id: 'synthetic-project',
};
const request = { scope, selected_case_ids: ['case-a'], allowed_case_ids: ['case-a', 'case-b'] };
const goal = {
  kind: 'latency_goal_v1' as const,
  goal_key: 'latency-primary',
  service_key: 'fixture-service',
  load_profile_hash: 'a'.repeat(64),
  target_users: 100,
  max_p95_ms: 500,
  max_incremental_monthly_cost: 0,
  currency: 'JPY' as const,
  permitted_change: 'isolated_fixture_only' as const,
};
function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'service-latency',
    key: 'performance.goal',
    level: 'product-fixed',
    state: 'decided',
    value: { p95: 500, users: 100 },
    basis: [{ ref: 'synthetic-goal', version: 'r1' }],
    decided_by: { kind: 'human', id: 'user:fixture-owner', role: 'owner' },
    decided_at: '2026-10-31T00:00:00.000Z',
    origin: 'console',
    status: 'active',
    ...overrides,
  };
}
function fixture(records: readonly DecisionRecord[] = [decision()]): JudgmentPrecedentDeps {
  return {
    resolveCaseBinding: vi.fn((_tenant, caseId) => ({ case_id: caseId, scope })),
    readLedger: vi.fn(({ caseId }) => records.filter((record) => record.case_id === caseId)),
    resolveGoals: vi.fn((source) => [
      {
        case_id: source.case_id,
        decision_id: source.decision_id,
        decision_version_hash: source.decision_version_hash,
        constraints: { ...goal, goal_key: `latency-${source.case_id}-${source.decision_id}` },
      },
    ]),
  };
}
function snapshot(result: JudgmentPrecedentResult) {
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected a ready snapshot');
  return result.snapshot;
}

describe('judgment precedent snapshots (pure injected fixture ports)', () => {
  it('pins current human decisions, full scope and structured goals without a production reader', () => {
    const deps = fixture();
    const result = snapshot(createJudgmentPrecedentSnapshot(request, deps));
    expect(deps.readLedger).toHaveBeenCalledExactlyOnceWith({
      tenantSlug: scope.tenant_slug,
      caseId: 'case-a',
    });
    expect(result.scope_hash).toBe(judgmentCanonicalHash(scope));
    expect(result.evidence_refs[0]).toMatchObject({ case_id: 'case-a', decision_id: 'D-0001' });
    expect(result.goals[0].decision_source_key).toBe(result.evidence_refs[0].source_key);
    expect(result.decisions[0].record).toEqual(decision());
    expect(result.evidence_refs[0].decision_version_hash).toBe(judgmentCanonicalHash(decision()));
  });

  it.each([
    { ...scope, tenant_slug: 'other-tenant' },
    { ...scope, tier: 'personal' },
    { ...scope, organization_id: 'other-org' },
    { ...scope, project_id: 'other-project' },
    { ...scope, mission_id: 'MSN-OTHER' },
    { ...scope, nhi_id: 'another-principal' },
  ])('rejects mismatched mapped scope before reads: %j', (mapped) => {
    const deps = fixture();
    deps.resolveCaseBinding = vi.fn((_tenant, caseId) => ({
      case_id: caseId,
      scope: mapped as ScopeContext,
    }));
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      status: 'unavailable',
      reason: 'scope_mismatch',
    });
    expect(deps.readLedger).not.toHaveBeenCalled();
  });

  it('checks all cases before reading the first and refuses missing or broader mappings', () => {
    const deps = fixture();
    deps.resolveCaseBinding = vi.fn((_tenant, caseId) =>
      caseId === 'case-a' ? { case_id: caseId, scope } : undefined
    );
    expect(
      createJudgmentPrecedentSnapshot({ ...request, selected_case_ids: ['case-a', 'case-b'] }, deps)
    ).toMatchObject({ status: 'unavailable', reason: 'scope_mismatch' });
    expect(deps.readLedger).not.toHaveBeenCalled();
    deps.resolveCaseBinding = () => ({
      case_id: 'case-a',
      scope: { tier: 'confidential', tenant_slug: scope.tenant_slug },
    });
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'scope_mismatch',
    });
    expect(deps.readLedger).not.toHaveBeenCalled();
  });

  it('requires selected cases to be explicitly allowed before reading', () => {
    const deps = fixture();
    expect(
      createJudgmentPrecedentSnapshot({ ...request, allowed_case_ids: ['case-b'] }, deps)
    ).toMatchObject({ reason: 'scope_mismatch' });
    expect(deps.resolveCaseBinding).not.toHaveBeenCalled();
    expect(deps.readLedger).not.toHaveBeenCalled();
  });

  it.each([
    { selected_case_ids: [] },
    { selected_case_ids: ['case-a', 'case-a'] },
    { selected_case_ids: ['../case-a'] },
    { allowed_case_ids: Array.from({ length: 11 }, (_, index) => `case-${index}`) },
    { scope: { ...scope, tenant_slug: 'confidential' } },
  ])('refuses malformed or unbounded requests without reading: %j', (override) => {
    const deps = fixture();
    expect(
      createJudgmentPrecedentSnapshot({ ...request, ...override } as typeof request, deps)
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_schema' });
    expect(deps.readLedger).not.toHaveBeenCalled();
  });

  it('does not inherit a missing mission/task binding from a broader case', () => {
    const deps = fixture();
    expect(
      createJudgmentPrecedentSnapshot(
        {
          ...request,
          scope: { ...scope, mission_id: 'MSN-FIXTURE', task_id: 'task-1' },
        },
        deps
      )
    ).toMatchObject({ reason: 'scope_mismatch' });
    expect(deps.readLedger).not.toHaveBeenCalled();
  });

  it('rejects case confusion returned by the reader', () => {
    const deps = fixture();
    deps.readLedger = () => [decision({ case_id: 'case-b' })];
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'scope_mismatch',
    });
  });

  it('keeps identical decision IDs in different cases distinct', () => {
    const deps = fixture([decision(), decision({ case_id: 'case-b' })]);
    const result = snapshot(
      createJudgmentPrecedentSnapshot({ ...request, selected_case_ids: ['case-a', 'case-b'] }, deps)
    );
    expect(new Set(result.evidence_refs.map((ref) => ref.source_key)).size).toBe(2);
    expect(result.evidence_refs.map((ref) => ref.decision_id)).toEqual(['D-0001', 'D-0001']);
  });

  it('rejects duplicate IDs within a case, including conflicting versions', () => {
    for (const other of [decision(), decision({ value: { p95: 1800 } })]) {
      expect(createJudgmentPrecedentSnapshot(request, fixture([decision(), other]))).toMatchObject({
        reason: 'conflicting_precedents',
      });
    }
  });

  it('rejects multiple active decisions for the same case/item/key even with different IDs', () => {
    expect(
      createJudgmentPrecedentSnapshot(
        request,
        fixture([decision(), decision({ id: 'D-0002', value: { users: 65 } })])
      )
    ).toMatchObject({ reason: 'conflicting_precedents' });
  });

  it.each([
    { status: 'superseded' as const },
    { state: 'rejected' as const },
    { state: 'proposed' as const },
  ])('does not use inactive or undecided evidence: %j', (override) => {
    const deps = fixture([decision(override)]);
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'stale_precedent',
    });
    expect(deps.resolveGoals).not.toHaveBeenCalled();
  });

  it('requires human provenance and nonempty basis for active decided records', () => {
    const withoutHuman = decision();
    delete withoutHuman.decided_by;
    for (const item of [
      withoutHuman,
      decision({ basis: [] }),
      decision({
        decided_by: {
          kind: 'human',
          id: 'user:fixture-owner',
          on_behalf_of: { actor_id: 'customer:fixture' },
        },
      }),
    ]) {
      expect(createJudgmentPrecedentSnapshot(request, fixture([item]))).toMatchObject({
        reason: 'missing_evidence',
      });
    }
  });

  it('rejects forged kinds, invalid finite JSON and unknown record fields', () => {
    for (const item of [
      { ...decision(), decided_by: { kind: 'agent', id: 'user:fixture-owner' } },
      decision({ value: { p95: Infinity } }),
      decision({ value: { p95: undefined } }),
      { ...decision(), unexpected_authority: true },
    ]) {
      expect(
        createJudgmentPrecedentSnapshot(request, fixture([item as DecisionRecord]))
      ).toMatchObject({ reason: 'missing_evidence' });
    }
  });

  it('rejects prototype-setting source keys before canonicalization can erase them', () => {
    for (const p95 of [500, 1800]) {
      const value: unknown = JSON.parse(`{"nested":{"__proto__":{"p95":${p95}}}}`);
      const deps = fixture([decision({ value })]);
      expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
        reason: 'missing_evidence',
      });
      expect(deps.resolveGoals).not.toHaveBeenCalled();
    }
  });

  it('sanitizes mapping, reader and goal adapter failures', () => {
    for (const operation of ['resolveCaseBinding', 'readLedger', 'resolveGoals'] as const) {
      const deps = fixture();
      deps[operation] = () => {
        throw new Error('secret other-tenant evidence');
      };
      const result = createJudgmentPrecedentSnapshot(request, deps);
      expect(result.status).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('other-tenant');
    }
  });

  it('does not infer structured goals from arbitrary record text', () => {
    const deps = fixture([decision({ value: 'Approve all infrastructure expenses' })]);
    deps.resolveGoals = () => [];
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'missing_evidence',
    });
  });

  it.each(['case', 'decision', 'version', 'number', 'unknown'])(
    'rejects unbound or invalid trusted goal facts: %s',
    (change) => {
      const deps = fixture();
      deps.resolveGoals = (source) => [
        {
          case_id: change === 'case' ? 'case-b' : source.case_id,
          decision_id: change === 'decision' ? 'D-0002' : source.decision_id,
          decision_version_hash:
            change === 'version' ? '0'.repeat(64) : source.decision_version_hash,
          constraints: {
            ...goal,
            ...(change === 'number' ? { max_p95_ms: NaN } : {}),
            ...(change === 'unknown' ? { arbitrary_approval: 'approved' } : {}),
          },
        },
      ];
      expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
        reason: 'missing_evidence',
      });
    }
  );

  it('binds structured goal facts into the snapshot hash', () => {
    const first = snapshot(createJudgmentPrecedentSnapshot(request, fixture()));
    const deps = fixture();
    deps.resolveGoals = (source) => [{ ...source, constraints: { ...goal, max_p95_ms: 400 } }];
    // source_key is not accepted as an arbitrary trusted binding field.
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'missing_evidence',
    });
    deps.resolveGoals = ({ case_id, decision_id, decision_version_hash }) => [
      {
        case_id,
        decision_id,
        decision_version_hash,
        constraints: { ...goal, goal_key: 'latency-case-a-D-0001', max_p95_ms: 400 },
      },
    ];
    const next = snapshot(createJudgmentPrecedentSnapshot(request, deps));
    expect(next.evidence_refs).toEqual(first.evidence_refs);
    expect(next.snapshot_hash).not.toBe(first.snapshot_hash);
  });

  it('normalizes unordered cases/decisions/basis/bound_to but preserves full provenance hashes', () => {
    const firstRecord = decision({
      basis: [
        { ref: 'z', version: 'r1', note: 'retained', approved: 'minute-1' },
        { ref: 'a', version: 'r2' },
      ],
      bound_to: ['goal-z', 'goal-a'],
    });
    const secondRecord = decision({ case_id: 'case-b' });
    const first = snapshot(
      createJudgmentPrecedentSnapshot(
        { ...request, selected_case_ids: ['case-b', 'case-a'] },
        fixture([secondRecord, firstRecord])
      )
    );
    const reversed = decision({
      ...firstRecord,
      basis: [...firstRecord.basis].reverse(),
      bound_to: ['goal-a', 'goal-z'],
    });
    const next = snapshot(
      createJudgmentPrecedentSnapshot(
        { ...request, selected_case_ids: ['case-a', 'case-b'] },
        fixture([reversed, secondRecord])
      )
    );
    expect(next.snapshot_hash).toBe(first.snapshot_hash);
    const changed = decision({
      ...firstRecord,
      decided_by: { kind: 'human', id: 'user:another-owner' },
    });
    expect(
      snapshot(
        createJudgmentPrecedentSnapshot(
          { ...request, selected_case_ids: ['case-a', 'case-b'] },
          fixture([changed, secondRecord])
        )
      ).snapshot_hash
    ).not.toBe(first.snapshot_hash);
    const changedBasis = decision({
      ...firstRecord,
      basis: [{ ...firstRecord.basis[0], approved: 'minute-2' }, firstRecord.basis[1]],
    });
    expect(
      snapshot(
        createJudgmentPrecedentSnapshot(
          { ...request, selected_case_ids: ['case-a', 'case-b'] },
          fixture([changedBasis, secondRecord])
        )
      ).snapshot_hash
    ).not.toBe(first.snapshot_hash);
  });

  it('detaches snapshot records from the injected reader and leaves reader arrays unchanged', () => {
    const record = decision({
      basis: [
        { ref: 'z', version: '1' },
        { ref: 'a', version: '1' },
      ],
    });
    const result = snapshot(createJudgmentPrecedentSnapshot(request, fixture([record])));
    expect(record.basis[0].ref).toBe('z');
    (record.value as { p95: number }).p95 = 999;
    expect(result.decisions[0].record.value).toEqual({ p95: 500, users: 100 });
  });

  it('recreating a snapshot detects a changed value or basis version', () => {
    const first = snapshot(createJudgmentPrecedentSnapshot(request, fixture()));
    for (const changed of [
      decision({ value: { p95: 400, users: 100 } }),
      decision({ basis: [{ ref: 'synthetic-goal', version: 'r2' }] }),
    ]) {
      const next = snapshot(createJudgmentPrecedentSnapshot(request, fixture([changed])));
      expect(next.evidence_refs[0].source_key).toBe(first.evidence_refs[0].source_key);
      expect(next.evidence_refs[0].decision_version_hash).not.toBe(
        first.evidence_refs[0].decision_version_hash
      );
      expect(next.snapshot_hash).not.toBe(first.snapshot_hash);
    }
  });

  it('preserves original decision strings in the version hash and refuses lossy basis trimming', () => {
    const record = decision({ note: '  provenance note  ' });
    const result = snapshot(createJudgmentPrecedentSnapshot(request, fixture([record])));
    expect(result.decisions[0].record.note).toBe('  provenance note  ');
    expect(result.evidence_refs[0].decision_version_hash).toBe(judgmentCanonicalHash(record));
    const trimmed = snapshot(
      createJudgmentPrecedentSnapshot(request, fixture([decision({ note: 'provenance note' })]))
    );
    expect(result.snapshot_hash).not.toBe(trimmed.snapshot_hash);
    expect(
      createJudgmentPrecedentSnapshot(
        request,
        fixture([decision({ basis: [{ ref: ' source ', version: 'r1' }] })])
      )
    ).toMatchObject({ reason: 'missing_evidence' });
  });

  it('bounds active candidates and rejects ambiguous goal keys', () => {
    const records = Array.from({ length: 11 }, (_, index) =>
      decision({ id: `D-${String(index + 1).padStart(4, '0')}`, item: `item-${index}` })
    );
    expect(createJudgmentPrecedentSnapshot(request, fixture(records))).toMatchObject({
      reason: 'missing_evidence',
    });
    const deps = fixture([decision(), decision({ id: 'D-0002', item: 'another-item' })]);
    deps.resolveGoals = ({ case_id, decision_id, decision_version_hash }) => [
      { case_id, decision_id, decision_version_hash, constraints: goal },
    ];
    expect(createJudgmentPrecedentSnapshot(request, deps)).toMatchObject({
      reason: 'conflicting_precedents',
    });
  });

  it('rejects conflicting conditions across cases for the same service and load profile', () => {
    const deps = fixture([decision(), decision({ case_id: 'case-b' })]);
    deps.resolveGoals = ({ case_id, decision_id, decision_version_hash }) => [
      {
        case_id,
        decision_id,
        decision_version_hash,
        constraints: {
          ...goal,
          goal_key: `goal-${case_id}`,
          max_p95_ms: case_id === 'case-a' ? 500 : 1800,
        },
      },
    ];
    expect(
      createJudgmentPrecedentSnapshot({ ...request, selected_case_ids: ['case-a', 'case-b'] }, deps)
    ).toMatchObject({ reason: 'conflicting_precedents' });
  });
});

describe('judgment canonical hash', () => {
  it('uses deterministic canonical property order while retaining array order', () => {
    expect(judgmentCanonicalHash({ a: 1, b: { c: 2 } })).toBe(
      judgmentCanonicalHash({ b: { c: 2 }, a: 1 })
    );
    expect(judgmentCanonicalHash([1, 2])).not.toBe(judgmentCanonicalHash([2, 1]));
  });
  it('rejects lossy, cyclic, non-JSON and sparse values', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      { missing: undefined },
      new Date(),
      cycle,
      Array(2),
    ]) {
      expect(() => judgmentCanonicalHash(value)).toThrow();
    }
  });

  it('rejects own prototype-setting keys and metadata omitted by canonical JSON', () => {
    const accessor = Object.defineProperty({}, 'p95', {
      enumerable: true,
      get: () => {
        throw new Error('Accessor must never run');
      },
    });
    const hidden = Object.defineProperty({}, 'p95', { enumerable: false, value: 1800 });
    const symbols = { [Symbol('p95')]: 1800 };
    const customArray = Object.assign([500], { p95: 1800 });
    const nonIndexArray = Object.assign([500], { '4294967295': 1800 });
    const customPrototypeArray = Object.setPrototypeOf([500], { map: () => [] });
    for (const value of [
      JSON.parse('{"__proto__":{"p95":500}}'),
      JSON.parse('{"__proto__":{"p95":1800}}'),
      { nested: JSON.parse('{"__proto__":{"p95":1800}}') },
      accessor,
      hidden,
      symbols,
      customArray,
      nonIndexArray,
      customPrototypeArray,
    ]) {
      expect(() => judgmentCanonicalHash(value)).toThrow(/Snapshot/);
    }
    expect(
      createJudgmentPrecedentSnapshot(request, fixture([decision({ value: nonIndexArray })]))
    ).toMatchObject({ reason: 'missing_evidence' });
    expect(
      createJudgmentPrecedentSnapshot(request, fixture([decision({ value: customPrototypeArray })]))
    ).toMatchObject({ reason: 'missing_evidence' });
  });
});
