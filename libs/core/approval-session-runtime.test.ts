import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// secure-io accepts logical (repo-relative) paths and resolves them itself —
// the mock must do the same against the hermetic KYBERION_ROOT, otherwise
// writes land in the real working directory.
const secureIo = vi.hoisted(() => {
  const abs = (filePath: string) =>
    path.isAbsolute(filePath) ? filePath : path.join(process.env.KYBERION_ROOT || '', filePath);
  return {
    safeAppendFileSync: (filePath: string, data: string) => {
      fs.mkdirSync(path.dirname(abs(filePath)), { recursive: true });
      fs.appendFileSync(abs(filePath), data, 'utf8');
    },
    safeExistsSync: (filePath: string) => fs.existsSync(abs(filePath)),
    safeMkdir: (dirPath: string) => fs.mkdirSync(abs(dirPath), { recursive: true }),
    safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
      options.encoding === null
        ? fs.readFileSync(abs(filePath))
        : fs.readFileSync(abs(filePath), 'utf8'),
    safeReaddir: (dirPath: string) =>
      fs.existsSync(abs(dirPath)) ? fs.readdirSync(abs(dirPath)) : [],
    safeWriteFile: (filePath: string, data: string | Buffer) => {
      fs.mkdirSync(path.dirname(abs(filePath)), { recursive: true });
      fs.writeFileSync(abs(filePath), data);
    },
  };
});

vi.mock('./secure-io.js', () => secureIo);

// The work-loop summary drags in the whole intent catalog + schema registry;
// it is irrelevant here, so stub it out.
vi.mock('./work-design.js', () => ({
  buildOrganizationWorkLoopSummary: () => undefined,
}));

type ApprovalStoreModule = typeof import('./approval-store.js');

describe('approval runtime hardening (KC-03)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-approval-kc03-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  function readEvents(store: ApprovalStoreModule, channel: string): Array<Record<string, any>> {
    const eventPath = path.join(tmpRoot, store.approvalEventLogicalPath(channel));
    if (!fs.existsSync(eventPath)) return [];
    return fs
      .readFileSync(eventPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  describe('session action cache', () => {
    const descriptor = { action: 'secret:set', targetClass: 'service:github' };

    it('seeds the cache from a human approval and records session_cache_written', async () => {
      const store = await import('./approval-store.js');
      const created = store.createApprovalRequest('mission_controller', {
        channel: 'terminal',
        threadTs: 'ts-cache',
        correlationId: 'corr-cache',
        requestedBy: 'worker:test',
        draft: { title: 'cache seed', summary: 'approve and cache' },
      });

      store.decideApprovalRequest('mission_controller', {
        channel: 'terminal',
        requestId: created.id,
        decision: 'approved',
        decidedBy: 'human:operator',
        decidedByType: 'human',
        authenticated: true,
        sessionCache: descriptor,
      });

      const entry = store.lookupSessionApprovalCache(descriptor);
      expect(entry).not.toBeNull();
      expect(entry?.grantedByRequestId).toBe(created.id);
      expect(entry?.grantedBy).toBe('human:operator');

      const cacheEvent = readEvents(store, 'terminal').find(
        (event) => event.event === 'session_cache_written'
      );
      expect(cacheEvent).toBeDefined();
      expect(cacheEvent?.request_id).toBe(created.id);
      expect(cacheEvent?.action).toBe('secret:set');
      expect(cacheEvent?.target_class).toBe('service:github');
      expect(cacheEvent?.granted_by).toBe('human:operator');
    });

    it('refuses to seed the cache from a non-human or unauthenticated decision', async () => {
      const store = await import('./approval-store.js');
      const created = store.createApprovalRequest('mission_controller', {
        channel: 'terminal',
        threadTs: 'ts-nonhuman',
        correlationId: 'corr-nonhuman',
        requestedBy: 'worker:test',
        draft: { title: 'non-human seed', summary: 'must be refused' },
      });

      expect(() =>
        store.decideApprovalRequest('mission_controller', {
          channel: 'terminal',
          requestId: created.id,
          decision: 'approved',
          decidedBy: 'agent:auto',
          decidedByType: 'ai_agent',
          authenticated: true,
          sessionCache: descriptor,
        })
      ).toThrow('human decider');
      expect(store.lookupSessionApprovalCache(descriptor)).toBeNull();
      // Fail-fast: the invalid opt-in must not persist the decision either.
      expect(store.loadApprovalRequest('terminal', created.id)?.status).toBe('pending');

      expect(() =>
        store.decideApprovalRequest('mission_controller', {
          channel: 'terminal',
          requestId: created.id,
          decision: 'approved',
          decidedBy: 'human:operator',
          decidedByType: 'human',
          authenticated: false,
          sessionCache: descriptor,
        })
      ).toThrow('authenticated human');
      expect(store.lookupSessionApprovalCache(descriptor)).toBeNull();
    });

    it('never caches a rejection', async () => {
      const store = await import('./approval-store.js');
      const created = store.createApprovalRequest('mission_controller', {
        channel: 'terminal',
        threadTs: 'ts-reject',
        correlationId: 'corr-reject',
        requestedBy: 'worker:test',
        draft: { title: 'reject', summary: 'deny must pass through' },
      });

      const decided = store.decideApprovalRequest('mission_controller', {
        channel: 'terminal',
        requestId: created.id,
        decision: 'rejected',
        decidedBy: 'human:operator',
        decidedByType: 'human',
        authenticated: true,
        sessionCache: descriptor,
      });

      expect(decided.status).toBe('rejected');
      expect(store.lookupSessionApprovalCache(descriptor)).toBeNull();
      expect(
        readEvents(store, 'terminal').some((event) => event.event === 'session_cache_written')
      ).toBe(false);
    });

    it('expires cache entries together with the originating approval', async () => {
      const store = await import('./approval-store.js');
      const created = store.createApprovalRequest('mission_controller', {
        channel: 'terminal',
        threadTs: 'ts-expiry',
        correlationId: 'corr-expiry',
        requestedBy: 'worker:test',
        draft: { title: 'expiring grant', summary: 'cache dies with the grant' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      store.decideApprovalRequest('mission_controller', {
        channel: 'terminal',
        requestId: created.id,
        decision: 'approved',
        decidedBy: 'human:operator',
        decidedByType: 'human',
        authenticated: true,
        sessionCache: descriptor,
      });

      expect(store.lookupSessionApprovalCache(descriptor)).not.toBeNull();
      expect(store.lookupSessionApprovalCache(descriptor, Date.now() + 7_200_000)).toBeNull();
      // The expired entry is evicted, not just hidden.
      expect(store.lookupSessionApprovalCache(descriptor)).toBeNull();
    });

    it('records durable auto-approval events for cache hits', async () => {
      const store = await import('./approval-store.js');
      store.recordSessionCacheAutoApproval('mission_controller', {
        entry: {
          key: 'secret:set::service:github',
          action: 'secret:set',
          targetClass: 'service:github',
          grantedByRequestId: '123e4567-e89b-42d3-a456-426614174000',
          grantedBy: 'human:operator',
          grantedAt: '2026-07-20T00:00:00.000Z',
          channel: 'terminal',
          storageChannel: 'terminal',
        },
        operationId: 'secret:set',
        agentId: 'agent-1',
        correlationId: 'corr-hit-2',
      });

      const event = readEvents(store, 'terminal').find(
        (item) => item.event === 'auto_approved_via_session_cache'
      );
      expect(event).toBeDefined();
      expect(event?.correlation_id).toBe('corr-hit-2');
      expect(event?.granted_by).toBe('human:operator');
      expect(event?.target_class).toBe('service:github');
    });
  });

  describe('source-scoped cancellation', () => {
    function createWithSource(
      store: ApprovalStoreModule,
      correlationId: string,
      source: { missionId?: string; taskId?: string; agentId?: string }
    ) {
      return store.createApprovalRequest('mission_controller', {
        channel: 'terminal',
        threadTs: `ts-${correlationId}`,
        correlationId,
        requestedBy: 'worker:test',
        draft: { title: correlationId, summary: 'source-scoped' },
        source,
      });
    }

    it('cancels all pending requests for a source and leaves other sources untouched', async () => {
      const store = await import('./approval-store.js');
      const r1 = createWithSource(store, 'corr-t1-a', { missionId: 'm1', taskId: 't1' });
      const r2 = createWithSource(store, 'corr-t1-b', { missionId: 'm1', taskId: 't1' });
      const other = createWithSource(store, 'corr-t2', { missionId: 'm1', taskId: 't2' });
      const decided = createWithSource(store, 'corr-t1-done', { missionId: 'm1', taskId: 't1' });
      store.decideApprovalRequest('mission_controller', {
        channel: 'terminal',
        requestId: decided.id,
        decision: 'approved',
        decidedBy: 'human:operator',
      });

      const cancelled = store.cancelApprovalRequestsBySource('mission_controller', {
        source: { taskId: 't1' },
        cancelledBy: 'mission_controller',
        reason: 'task aborted',
      });

      expect(cancelled.map((record) => record.id).sort()).toEqual([r1.id, r2.id].sort());
      expect(store.loadApprovalRequest('terminal', r1.id)?.status).toBe('cancelled');
      expect(store.loadApprovalRequest('terminal', r2.id)?.status).toBe('cancelled');
      expect(store.loadApprovalRequest('terminal', other.id)?.status).toBe('pending');
      expect(store.loadApprovalRequest('terminal', decided.id)?.status).toBe('approved');
      expect(store.listApprovalRequests({ status: 'pending' }).map((record) => record.id)).toEqual([
        other.id,
      ]);

      const events = readEvents(store, 'terminal').filter((event) => event.event === 'cancelled');
      expect(events).toHaveLength(2);
      expect(events[0].cancelled_by).toBe('mission_controller');
      expect(events[0].reason).toBe('task aborted');
      expect(events[0].source.taskId).toBe('t1');
    });

    it('matches on mission scope across tasks and is idempotent', async () => {
      const store = await import('./approval-store.js');
      createWithSource(store, 'corr-m1-t1', { missionId: 'm1', taskId: 't1' });
      createWithSource(store, 'corr-m1-t2', { missionId: 'm1', taskId: 't2' });
      createWithSource(store, 'corr-m2', { missionId: 'm2', taskId: 't9' });

      const first = store.cancelApprovalRequestsBySource('mission_controller', {
        source: { missionId: 'm1' },
      });
      expect(first).toHaveLength(2);

      const second = store.cancelApprovalRequestsBySource('mission_controller', {
        source: { missionId: 'm1' },
      });
      expect(second).toHaveLength(0);
      expect(store.listApprovalRequests({ status: 'pending' })).toHaveLength(1);
    });

    it('requires at least one source field', async () => {
      const store = await import('./approval-store.js');
      expect(() =>
        store.cancelApprovalRequestsBySource('mission_controller', { source: {} })
      ).toThrow('at least one source field');
    });

    it('refuses to decide a cancelled request', async () => {
      const store = await import('./approval-store.js');
      const record = createWithSource(store, 'corr-cancel-decide', { taskId: 't1' });
      store.cancelApprovalRequestsBySource('mission_controller', { source: { taskId: 't1' } });

      expect(() =>
        store.decideApprovalRequest('mission_controller', {
          channel: 'terminal',
          requestId: record.id,
          decision: 'approved',
          decidedBy: 'human:operator',
        })
      ).toThrow('cancelled');
    });
  });
});
