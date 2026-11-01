import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileSchemaFromPath,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core';
import {
  MAX_DISPATCH_ATTEMPTS,
  MISSION_QUEUE_TERMINAL_RETENTION_MS,
  dispatchNextQueuedMission,
  enqueueMission,
  pruneMissionQueue,
  type MissionQueueEntry,
} from './mission-queue.js';
import { DEFAULT_JSONL_CHUNK_BYTES } from '@agent/core/jsonl-read';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const QUEUE_DIR = pathResolver.shared('tmp/mission-queue-tests');
const QUEUE_PATH = path.join(QUEUE_DIR, 'mission-queue-schema-test.jsonl');

describe('mission-queue', () => {
  beforeEach(() => {
    safeRmSync(QUEUE_PATH, { force: true });
    if (!safeExistsSync(QUEUE_DIR)) safeMkdir(QUEUE_DIR, { recursive: true });
  });

  it('appends queue entries that satisfy the schema', async () => {
    await enqueueMission(QUEUE_PATH, 'MSN-TEST-SCHEMA', 'confidential', 7, ['MSN-DEP-1']);
    const raw = safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string;
    const entry = JSON.parse(raw.trim().split('\n')[0] || '{}');
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('knowledge/product/schemas/mission-queue.schema.json')
    );
    const valid = validate(entry);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('skips malformed records when selecting the next mission', async () => {
    safeWriteFile(
      QUEUE_PATH,
      [
        '[]',
        JSON.stringify({
          mission_id: 'MSN-BAD',
          tier: 'confidential',
          priority: 'urgent',
          status: 'pending',
          enqueued_at: new Date().toISOString(),
          dependencies: [],
        }),
        JSON.stringify({
          mission_id: 'MSN-GOOD',
          tier: 'confidential',
          priority: 1,
          status: 'pending',
          enqueued_at: new Date().toISOString(),
          dependencies: [],
        }),
      ].join('\n') + '\n'
    );

    const dispatched: string[] = [];
    await dispatchNextQueuedMission(
      QUEUE_PATH,
      () => ({ ok: true, missing: [] }),
      async (missionId) => {
        dispatched.push(missionId);
      }
    );

    expect(dispatched).toEqual(['MSN-GOOD']);
  });

  function entry(missionId: string, priority: number, dependencies: string[] = []) {
    return JSON.stringify({
      mission_id: missionId,
      tier: 'public',
      priority,
      status: 'pending',
      enqueued_at: new Date().toISOString(),
      dependencies,
    });
  }

  function statuses(): Record<string, string> {
    const raw = safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string;
    return Object.fromEntries(
      raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((value: { mission_id: string; status: string }) => [value.mission_id, value.status])
    );
  }

  it('normalizes enqueued dependency ids', async () => {
    await enqueueMission(QUEUE_PATH, 'msn-child', 'public', 5, [' msn-a ', 'MSN-A', '']);
    const raw = safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string;
    expect(JSON.parse(raw.trim()).dependencies).toEqual(['MSN-A']);
  });

  it('passes queue-entry dependencies to the check and skips unready entries', async () => {
    safeWriteFile(
      QUEUE_PATH,
      [entry('MSN-BLOCKED', 9, ['MSN-PRE']), entry('MSN-READY', 1)].join('\n') + '\n'
    );
    const seen: Array<[string, string[]]> = [];
    const dispatched: string[] = [];
    await dispatchNextQueuedMission(
      QUEUE_PATH,
      (missionId, queueDependencies) => {
        seen.push([missionId, queueDependencies]);
        return queueDependencies.length
          ? { ok: false, missing: queueDependencies }
          : { ok: true, missing: [] };
      },
      async (missionId) => {
        dispatched.push(missionId);
      }
    );
    expect(seen[0]).toEqual(['MSN-BLOCKED', ['MSN-PRE']]);
    expect(dispatched).toEqual(['MSN-READY']);
    expect(statuses()).toEqual({ 'MSN-BLOCKED': 'pending', 'MSN-READY': 'dispatched' });
  });

  it('rejects malformed mission or dependency ids at enqueue', async () => {
    await expect(enqueueMission(QUEUE_PATH, 'ab', 'public')).rejects.toThrow(
      '[MISSION_PREREQUISITES_INVALID]'
    );
    await expect(enqueueMission(QUEUE_PATH, 'MSN-OK-1', 'public', 5, ['ab'])).rejects.toThrow(
      'Invalid mission id(s) in dependencies: AB'
    );
    expect(safeExistsSync(QUEUE_PATH)).toBe(false);
  });

  it('parks an entry as failed after repeated start failures so it stops blocking', async () => {
    safeWriteFile(QUEUE_PATH, [entry('MSN-BROKEN', 9), entry('MSN-NEXT', 1)].join('\n') + '\n');
    const failing = async (missionId: string) => {
      if (missionId === 'MSN-BROKEN') throw new Error('start exploded');
    };
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      await expect(
        dispatchNextQueuedMission(QUEUE_PATH, () => ({ ok: true, missing: [] }), failing)
      ).rejects.toThrow('start exploded');
    }
    expect(statuses()).toEqual({ 'MSN-BROKEN': 'failed', 'MSN-NEXT': 'pending' });
    const broken = (safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((value: { mission_id: string }) => value.mission_id === 'MSN-BROKEN');
    expect(broken.metadata).toMatchObject({
      dispatch_attempts: MAX_DISPATCH_ATTEMPTS,
      last_error: 'start exploded',
    });

    const dispatched: string[] = [];
    await dispatchNextQueuedMission(
      QUEUE_PATH,
      () => ({ ok: true, missing: [] }),
      async (missionId) => {
        dispatched.push(missionId);
      }
    );
    expect(dispatched).toEqual(['MSN-NEXT']);
  });

  it('parks an unreadable legacy entry instead of throwing on every dispatch', async () => {
    safeWriteFile(QUEUE_PATH, [entry('ab', 9), entry('MSN-OK-2', 1)].join('\n') + '\n');
    const dispatched: string[] = [];
    await dispatchNextQueuedMission(
      QUEUE_PATH,
      (missionId) => {
        if (missionId === 'ab') throw new Error("[path-resolver] invalid mission id 'ab'");
        return { ok: true, missing: [] };
      },
      async (missionId) => {
        dispatched.push(missionId);
      }
    );
    expect(dispatched).toEqual(['MSN-OK-2']);
    expect(statuses()).toEqual({ ab: 'failed', 'MSN-OK-2': 'dispatched' });
  });

  it('keeps an entry pending when its start fails', async () => {
    safeWriteFile(QUEUE_PATH, entry('MSN-FAILS', 5) + '\n');
    await expect(
      dispatchNextQueuedMission(
        QUEUE_PATH,
        () => ({ ok: true, missing: [] }),
        async () => {
          throw new Error('[MISSION_PREREQUISITES_UNMET] boom');
        }
      )
    ).rejects.toThrow('MISSION_PREREQUISITES_UNMET');
    expect(statuses()).toEqual({ 'MSN-FAILS': 'pending' });
  });

  it('rejects a symlinked queue before reading or appending it', async () => {
    const targetPath = path.join(QUEUE_DIR, `mission-queue-target-${Date.now()}.jsonl`);
    const linkPath = path.join(QUEUE_DIR, `mission-queue-link-${Date.now()}.jsonl`);
    safeWriteFile(targetPath, '');
    safeSymlinkSync(targetPath, linkPath);
    try {
      await expect(enqueueMission(linkPath, 'MSN-SYMLINK', 'confidential')).rejects.toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
      await expect(
        dispatchNextQueuedMission(
          linkPath,
          () => ({ ok: true, missing: [] }),
          async () => undefined
        )
      ).rejects.toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(linkPath, { force: true });
      safeRmSync(targetPath, { force: true });
    }
  });
  describe('terminal-row retention', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    const row = (
      missionId: string,
      status: MissionQueueEntry['status'],
      enqueuedAgoMs: number,
      metadata?: MissionQueueEntry['metadata']
    ): MissionQueueEntry => ({
      mission_id: missionId,
      tier: 'confidential',
      priority: 5,
      status,
      enqueued_at: new Date(now - enqueuedAgoMs).toISOString(),
      dependencies: [],
      ...(metadata ? { metadata } : {}),
    });

    it('keeps every pending row and recent terminal rows, drops old terminal rows', () => {
      const queue = [
        row('MSN-OLD-PENDING', 'pending', 90 * DAY),
        row('MSN-OLD-DISPATCHED', 'dispatched', 30 * DAY),
        row('MSN-OLD-FAILED', 'failed', 30 * DAY),
        row('MSN-RECENT-DISPATCHED', 'dispatched', 2 * DAY),
        // Enqueued long ago, dispatched recently: age counts from dispatch.
        row('MSN-LATE-DISPATCH', 'dispatched', 60 * DAY, {
          dispatched_at: new Date(now - DAY).toISOString(),
        }),
        row('MSN-LATE-FAIL', 'failed', 60 * DAY, {
          last_attempt_at: new Date(now - DAY).toISOString(),
        }),
      ];
      expect(pruneMissionQueue(queue, now).map((entry) => entry.mission_id)).toEqual([
        'MSN-OLD-PENDING',
        'MSN-RECENT-DISPATCHED',
        'MSN-LATE-DISPATCH',
        'MSN-LATE-FAIL',
      ]);
      expect(MISSION_QUEUE_TERMINAL_RETENTION_MS).toBe(14 * DAY);
    });

    it('prunes old terminal rows on the dispatch rewrite and stamps dispatched_at', async () => {
      const old = new Date(Date.now() - MISSION_QUEUE_TERMINAL_RETENTION_MS - DAY).toISOString();
      const recent = new Date(Date.now() - DAY).toISOString();
      const line = (missionId: string, status: string, enqueuedAt: string) =>
        JSON.stringify({
          mission_id: missionId,
          tier: 'confidential',
          priority: 5,
          status,
          enqueued_at: enqueuedAt,
          dependencies: [],
        });
      safeWriteFile(
        QUEUE_PATH,
        [
          line('MSN-ANCIENT-DONE', 'dispatched', old),
          line('MSN-ANCIENT-FAILED', 'failed', old),
          line('MSN-RECENT-DONE', 'dispatched', recent),
          line('MSN-WAITING', 'pending', old),
          line('MSN-NEXT', 'pending', recent),
        ].join('\n') + '\n'
      );
      await dispatchNextQueuedMission(
        QUEUE_PATH,
        (missionId) => ({ ok: missionId === 'MSN-NEXT', missing: ['MSN-DEP'] }),
        async () => undefined
      );
      const rows = (safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string)
        .trim()
        .split('\n')
        .map((raw) => JSON.parse(raw));
      expect(rows.map((r) => [r.mission_id, r.status])).toEqual([
        ['MSN-RECENT-DONE', 'dispatched'],
        ['MSN-WAITING', 'pending'],
        ['MSN-NEXT', 'dispatched'],
      ]);
      expect(Number.isFinite(Date.parse(rows[2].metadata.dispatched_at))).toBe(true);
    });

    it('reads a queue that spans several read chunks', async () => {
      const filler = 'x'.repeat(2000);
      const lines: string[] = [];
      for (let i = 0; lines.join('\n').length < 2 * DEFAULT_JSONL_CHUNK_BYTES + 1; i++) {
        lines.push(
          JSON.stringify({
            mission_id: `MSN-DONE-${i}`,
            tier: 'confidential',
            priority: 5,
            status: 'dispatched',
            enqueued_at: new Date().toISOString(),
            dependencies: [],
            metadata: { last_error: filler },
          })
        );
      }
      lines.push(entry('MSN-AFTER-CHUNKS', 5));
      safeWriteFile(QUEUE_PATH, lines.join('\n') + '\n');
      const dispatched: string[] = [];
      await dispatchNextQueuedMission(
        QUEUE_PATH,
        () => ({ ok: true, missing: [] }),
        async (missionId) => {
          dispatched.push(missionId);
        }
      );
      expect(dispatched).toEqual(['MSN-AFTER-CHUNKS']);
      expect(statuses()['MSN-AFTER-CHUNKS']).toBe('dispatched');
    });
  });
});
