import { describe, it, expect } from 'vitest';
import { actuator } from './index.js';
import { handleAction } from './data-helpers.js';
import { describeOps } from './op-catalog.js';
import { safeWriteFile } from '@agent/core/secure-io';

describe('data-actuator: op catalog', () => {
  it('exposes 4 ops with capture/transform kinds', () => {
    const ops = describeOps();
    expect(ops.map((o) => o.op).sort()).toEqual(['aggregate', 'filter', 'join', 'query']);
    const kinds = Object.fromEntries(ops.map((o) => [o.op, o.kind]));
    expect(kinds).toMatchObject({
      query: 'capture',
      filter: 'transform',
      join: 'transform',
      aggregate: 'transform',
    });
    for (const op of ops) {
      expect(op.input_schema).toBeDefined();
      expect(op.examples?.length).toBeGreaterThan(0);
    }
  });

  it('registers on the SDK actuator', () => {
    expect(actuator.id).toBe('data-actuator');
  });
});

describe('data-actuator: aggregate', () => {
  it('counts rows per group from a tmp fixture', async () => {
    const file = `active/shared/tmp/data-actuator-agg-${Date.now()}.json`;
    safeWriteFile(
      file,
      JSON.stringify([
        { status: 'active', id: 'a1' },
        { status: 'active', id: 'a2' },
        { status: 'archived', id: 'b1' },
      ])
    );
    const result = (await handleAction({
      op: 'aggregate',
      params: { file, group_by: 'status', aggregations: [{ func: 'count', as: 'n' }] },
    })) as Array<Record<string, unknown>>;
    const byStatus = Object.fromEntries(result.map((r) => [r['status'], r['n']]));
    expect(byStatus).toMatchObject({ active: 2, archived: 1 });
  });
});

describe('data-actuator: query/filter', () => {
  const fixture = [
    { status: 'active', id: 'a1' },
    { status: 'active', id: 'a2' },
    { status: 'archived', id: 'b1' },
  ];
  it('query filters rows with where + select', async () => {
    const file = `active/shared/tmp/data-actuator-q-${Date.now()}.json`;
    safeWriteFile(file, JSON.stringify(fixture));
    const result = (await handleAction({
      op: 'query',
      params: { file, where: { status: 'active' }, select: ['id'] },
    })) as Array<Record<string, unknown>>;
    expect(result).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  });

  it('filter matches rows by predicate', async () => {
    const file = `active/shared/tmp/data-actuator-f-${Date.now()}.json`;
    safeWriteFile(file, JSON.stringify(fixture));
    const result = (await handleAction({
      op: 'filter',
      params: { file, where: { status: 'archived' } },
    })) as Array<Record<string, unknown>>;
    expect(result).toEqual([{ status: 'archived', id: 'b1' }]);
  });
});

describe('data-actuator: validation', () => {
  it('join without key throws', async () => {
    await expect(
      handleAction({
        op: 'join',
        params: { file_a: 'active/shared/staging/a.json', file_b: 'active/shared/staging/b.json' },
      })
    ).rejects.toThrow(/key/i);
  });
});
