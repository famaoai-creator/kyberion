import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DotWorkResultRow } from './dot-state-paths.js';
import {
  createDotReportMarker,
  dotResultCanonicalJson,
  dotResultDigest,
  executorReportKey,
  parseDotReportMarker,
  projectDotResultRecords,
  type DotResultScope,
} from './dot-result-records.js';
const scope: DotResultScope = {
  tier: 'confidential',
  tenant_slug: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'project-a',
};
const row = (dot = 'worker-a'): DotWorkResultRow => ({
  dot_id: dot,
  work_item_id: `item-${dot}`,
  action_ref: `action-${dot}`,
  attempt_id: `run-${dot}`,
  mode: 'pipeline',
  status: 'done',
  summary: 'Protected body',
  started_at: '2026-10-31T00:00:00.000Z',
  completed_at: '2026-10-31T00:00:01.000Z',
  tokens_used: 42,
  report_to_dot_id: dot,
});
const marker = (result = row()) =>
  createDotReportMarker({
    row: result,
    scope,
    reportTo: result.report_to_dot_id!,
    enqueuedAt: '2026-10-31T00:00:02.000Z',
  });

describe('append-only result report projection', () => {
  it('preserves unmarked legacy partial JSON row shapes and order without a scope', () => {
    const legacy = [{ dot_id: 'old', status: 'done' }, { status: 'failed' }, null];
    const projected = projectDotResultRecords(legacy);
    expect(projected).toEqual(legacy);
    expect(projected[0]).not.toBe(legacy[0]);
  });
  it('keeps exactly the original eight-input report key with or without an attempt', () => {
    for (const result of [row(), { ...row(), attempt_id: undefined }]) {
      const expected =
        'dot-executor:' +
        createHash('sha256')
          .update(
            JSON.stringify([
              result.dot_id,
              result.report_to_dot_id,
              result.work_item_id,
              result.action_ref,
              result.attempt_id,
              result.started_at,
              result.completed_at,
              result.status,
            ])
          )
          .digest('hex');
      expect(executorReportKey(result, result.report_to_dot_id!)).toBe(expected);
    }
  });
  it('merges markers once without duplicating outcomes or token accounting', () => {
    const original = row(),
      receipt = marker(original),
      other = row('worker-b');
    const before = JSON.stringify(original);
    const projected = projectDotResultRecords(
      [original, other, receipt, structuredClone(receipt)],
      scope
    ) as DotWorkResultRow[];
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({ ...original, report_enqueued_at: receipt.report_enqueued_at });
    expect(projected[1]).toEqual(other);
    expect(projected.reduce((sum, item) => sum + item.tokens_used!, 0)).toBe(84);
    expect(projected.filter((item) => item.status === 'done')).toHaveLength(2);
    expect(JSON.stringify(original)).toBe(before);
    expect(dotResultDigest(projected[0])).toBe(dotResultDigest(original));
  });
  it('preserves journals above 1 MiB in total while retaining the individual record bound', () => {
    const originals = Array.from({ length: 1100 }, (_, index) => ({
      ...row(`worker-${index}`),
      summary: 'x'.repeat(1200),
    }));
    expect(Buffer.byteLength(JSON.stringify(originals), 'utf8')).toBeGreaterThan(1024 * 1024);
    const projected = projectDotResultRecords(
      [...originals, marker(originals[0])],
      scope
    ) as DotWorkResultRow[];
    expect(projected).toHaveLength(originals.length);
    expect(projected.reduce((sum, result) => sum + result.tokens_used!, 0)).toBe(
      originals.length * 42
    );
    expect(projected[0].report_enqueued_at).toBeDefined();
    expect(projected.at(-1)).toEqual(originals.at(-1));
    expect(() => projectDotResultRecords([{ ...row(), summary: 'x'.repeat(1024 * 1024) }])).toThrow(
      '1 MiB'
    );
  });
  it('is independent of object key insertion order but covers all immutable result content', () => {
    const original = row();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(dotResultDigest(original)).toBe(dotResultDigest(reordered));
    expect(dotResultDigest({ ...original, summary: 'Changed' })).not.toBe(
      dotResultDigest(original)
    );
    expect(dotResultDigest({ ...original, tokens_used: 43 })).not.toBe(dotResultDigest(original));
    expect(dotResultDigest({ ...original, report_to_dot_id: 'other' })).not.toBe(
      dotResultDigest(original)
    );
  });
  it.each(['missing', 'wrong-tenant', 'wrong-org', 'wrong-project'] as const)(
    'refuses copied rows and marker with %s expected scope',
    (kind) => {
      const expected =
        kind === 'missing'
          ? undefined
          : {
              ...scope,
              ...(kind === 'wrong-tenant' ? { tenant_slug: 'tenant-b' } : {}),
              ...(kind === 'wrong-org' ? { organization_id: 'org-b' } : {}),
              ...(kind === 'wrong-project' ? { project_id: 'project-b' } : {}),
            };
      expect(() => projectDotResultRecords([row(), marker()], expected)).toThrow();
    }
  );
  it.each([
    'dot_id',
    'work_item_id',
    'action_ref',
    'attempt_id',
    'report_to_dot_id',
    'result_digest',
    'report_key',
  ] as const)('rejects marker %s mismatch even when other fields are well shaped', (field) => {
    const receipt = marker();
    const changed = {
      ...receipt,
      [field]:
        field === 'result_digest'
          ? 'a'.repeat(64)
          : field === 'report_key'
            ? 'dot-executor:' + 'a'.repeat(64)
            : 'other',
    };
    expect(() => projectDotResultRecords([row(), changed], scope)).toThrow();
  });
  it('rejects cross-DOT shared-file markers, orphans, early markers and ambiguous originals', () => {
    const original = row(),
      receipt = marker();
    for (const records of [
      [row('worker-b'), receipt],
      [receipt, original],
      [receipt],
      [original, original, receipt],
      [original, receipt, original],
    ])
      expect(() => projectDotResultRecords(records, scope)).toThrow();
  });
  it('rejects conflicting duplicate markers and cannot move or extend the first receipt time', () => {
    const receipt = marker();
    expect(() =>
      projectDotResultRecords(
        [row(), receipt, { ...receipt, report_enqueued_at: '2026-10-31T00:00:03.000Z' }],
        scope
      )
    ).toThrow();
    expect(() =>
      projectDotResultRecords(
        [{ ...row(), report_enqueued_at: '2026-10-31T00:00:03.000Z' }, receipt],
        scope
      )
    ).toThrow();
    expect(() =>
      projectDotResultRecords(
        [row(), { ...receipt, report_enqueued_at: '2026-10-31T00:00:00.000Z' }],
        scope
      )
    ).toThrow();
  });
  it.each(['status', 'tokens_used', 'summary', 'unknown'] as const)(
    'marker cannot carry privileged result field %s',
    (field) => {
      expect(() => parseDotReportMarker({ ...marker(), [field]: 'injected' })).toThrow();
    }
  );
  it('rejects unknown marker kind/version and detached parser inputs cannot mutate the original', () => {
    expect(() =>
      projectDotResultRecords([row(), { ...marker(), kind: 'unknown' }], scope)
    ).toThrow();
    expect(() => parseDotReportMarker({ ...marker(), schema_version: '2' })).toThrow();
    const receipt = marker(),
      parsed = parseDotReportMarker(receipt);
    parsed.scope.tenant_slug = 'changed';
    expect(receipt.scope.tenant_slug).toBe('tenant-a');
  });
  it('rejects skipped reports, recipient changes and missing real attempt identity', () => {
    expect(() => marker({ ...row(), status: 'skipped' })).toThrow();
    expect(() =>
      createDotReportMarker({
        row: row(),
        scope,
        reportTo: 'other',
        enqueuedAt: '2026-10-31T00:00:02.000Z',
      })
    ).toThrow();
    const original = row();
    delete original.attempt_id;
    expect(() => marker(original)).toThrow();
  });
  it('suppression is exactly paired with the original capability-unavailable result', () => {
    const original = row(),
      receipt = marker();
    expect(() =>
      createDotReportMarker({
        row: original,
        scope,
        reportTo: original.dot_id,
        enqueuedAt: receipt.report_enqueued_at,
        suppressed: 'capability_unavailable',
      })
    ).toThrow('suppression');
    expect(() =>
      projectDotResultRecords(
        [original, { ...receipt, report_suppressed: 'capability_unavailable' }],
        scope
      )
    ).toThrow('suppression');
    const unavailable = {
      ...original,
      reason_code: 'capability_unavailable' as const,
      status: 'blocked' as const,
      mode: 'escalated' as const,
    };
    expect(() => marker(unavailable)).toThrow('suppression');
    const valid = createDotReportMarker({
      row: unavailable,
      scope,
      reportTo: unavailable.dot_id,
      enqueuedAt: receipt.report_enqueued_at,
      suppressed: 'capability_unavailable',
    });
    expect(projectDotResultRecords([unavailable, valid], scope)).toEqual([
      {
        ...unavailable,
        report_enqueued_at: valid.report_enqueued_at,
        report_suppressed: 'capability_unavailable',
      },
    ]);
    const { report_suppressed: _, ...forged } = valid;
    expect(() => projectDotResultRecords([unavailable, forged], scope)).toThrow('suppression');
  });
  it.each([
    'skipped',
    'bad-completed',
    'bad-started',
    'reversed',
    'noncanonical',
    'bad-mode',
  ] as const)(
    'refuses forged persisted markers over %s originals while retaining unmarked legacy JSON',
    (condition) => {
      const original = row();
      if (condition === 'skipped') original.status = 'skipped';
      if (condition === 'bad-completed') original.completed_at = 'not-a-date';
      if (condition === 'bad-started') original.started_at = 'not-a-date';
      if (condition === 'reversed') original.started_at = '2026-10-31T00:00:03.000Z';
      if (condition === 'noncanonical') original.completed_at = '2026-10-31T00:00:01Z';
      if (condition === 'bad-mode') Object.assign(original, { mode: 'made-up' });
      const forged = {
        ...marker(),
        result_digest: dotResultDigest(original),
        report_key: executorReportKey(original, original.report_to_dot_id!),
      };
      expect(projectDotResultRecords([original])).toEqual([original]);
      expect(() => projectDotResultRecords([original, forged], scope)).toThrow();
      expect(() => marker(original)).toThrow();
    }
  );
  it('rejects lossy JavaScript, prototype collisions and out-of-range array properties without invoking getters', () => {
    const getter = Object.defineProperty({}, 'summary', {
      enumerable: true,
      get: () => {
        throw new Error('getter must not run');
      },
    });
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
    const symbol = { [Symbol('secret')]: 1 };
    const sparse = new Array(1),
      cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      Object.create(null),
      getter,
      hidden,
      symbol,
      JSON.parse('{"__proto__":{"summary":"lost"}}'),
      sparse,
      cyclic,
      Object.assign([1], { '4294967295': 2 }),
      { optional: undefined },
    ])
      expect(() => dotResultCanonicalJson(value)).toThrow();
  });
});
