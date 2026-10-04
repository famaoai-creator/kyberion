/**
 * Tests for scheduler-actuator.
 *
 * The store is declaration-only JSON under a governed dir, so tests exercise
 * the full handleAction path against an isolated scratch store
 * (active/shared/tmp/ — 24h TTL intermediates, safe for test fixtures).
 *
 * Set NODE_ENV=test (default in vitest) so the module does not auto-run main().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as pathResolver from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { actuator, handleAction } from './index.js';
import { __setStoreDirForTests, type ScheduleDeclaration } from './scheduler-helpers.js';
import { describeOps } from './op-catalog.js';

let testStoreDir: string;

beforeEach(() => {
  testStoreDir = pathResolver.rootResolve(
    `active/shared/tmp/scheduler-actuator-tests/${process.pid}-${Date.now()}`
  );
  safeMkdir(testStoreDir, { recursive: true });
  __setStoreDirForTests(testStoreDir);
});

afterEach(() => {
  __setStoreDirForTests(null);
  safeRmSync(testStoreDir);
});

describe('scheduler-actuator: op catalog', () => {
  it('describes 4 ops with the declared kinds', () => {
    const ops = describeOps();
    expect(ops).toHaveLength(4);
    const byOp = new Map(ops.map((op) => [op.op, op.kind]));
    expect(byOp.get('schedule')).toBe('apply');
    expect(byOp.get('list')).toBe('capture');
    expect(byOp.get('cancel')).toBe('apply');
    expect(byOp.get('fire')).toBe('apply');
    for (const op of ops) {
      expect(op.input_schema).toBeDefined();
      expect(op.examples).toBeDefined();
    }
  });

  it('exposes the catalog through the actuator definition', () => {
    expect(actuator.id).toBe('scheduler-actuator');
    expect(actuator.describeOps()).toHaveLength(4);
  });
});

describe('scheduler-actuator: schedule validation', () => {
  it('requires cron for schedule', async () => {
    await expect(
      handleAction({ op: 'schedule', params: { payload: { hello: 'world' } } })
    ).rejects.toThrow(/missing required fields.*params\.cron/i);
  });

  it('rejects a cron with fewer than 5 fields', async () => {
    await expect(
      handleAction({ op: 'schedule', params: { cron: '0 9 * *', payload: {} } })
    ).rejects.toThrow(/invalid cron/i);
  });

  it('rejects a non-cron string', async () => {
    await expect(
      handleAction({ op: 'schedule', params: { cron: 'every morning', payload: {} } })
    ).rejects.toThrow(/invalid cron/i);
  });

  it('rejects unknown ops via schema validation', async () => {
    await expect(handleAction({ op: 'daemonize' as never })).rejects.toThrow(/invalid input/i);
  });
});

describe('scheduler-actuator: store lifecycle', () => {
  it('schedule persists and list returns an array with the declaration', async () => {
    const created = (await handleAction({
      op: 'schedule',
      params: { id: 'sch-test', cron: '0 9 * * 1', payload: { job: 'brief' } },
    })) as ScheduleDeclaration;
    expect(created.id).toBe('sch-test');
    expect(created.cron).toBe('0 9 * * 1');
    expect(created.enabled).toBe(true);

    const listed = (await handleAction({ op: 'list', params: {} })) as ScheduleDeclaration[];
    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toHaveLength(1);
    expect(listed[0].payload).toEqual({ job: 'brief' });
  });

  it('fire returns the stored payload for manual triggering', async () => {
    await handleAction({
      op: 'schedule',
      params: { id: 'sch-fire', cron: '*/15 * * * *', payload: { run: 'sync' } },
    });
    const fired = (await handleAction({ op: 'fire', params: { id: 'sch-fire' } })) as {
      id: string;
      payload: Record<string, unknown>;
      fired_at: string;
    };
    expect(fired.id).toBe('sch-fire');
    expect(fired.payload).toEqual({ run: 'sync' });
    expect(fired.fired_at).toBeDefined();
  });

  it('cancel removes the declaration and fire then fails', async () => {
    await handleAction({
      op: 'schedule',
      params: { id: 'sch-gone', cron: '0 0 * * *', payload: {} },
    });
    const cancelled = (await handleAction({ op: 'cancel', params: { id: 'sch-gone' } })) as {
      id: string;
      cancelled: boolean;
    };
    expect(cancelled).toEqual({ id: 'sch-gone', cancelled: true });
    const listed = (await handleAction({ op: 'list', params: {} })) as ScheduleDeclaration[];
    expect(listed).toEqual([]);
    await expect(handleAction({ op: 'fire', params: { id: 'sch-gone' } })).rejects.toThrow(
      /no schedule found/i
    );
  });

  it('cancel requires an id', async () => {
    await expect(handleAction({ op: 'cancel', params: {} })).rejects.toThrow(
      /missing required fields.*params\.id/i
    );
  });
});
