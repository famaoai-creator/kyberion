import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { getFoundationIo } from '../foundation/io.js';
import { readJsonLines } from '../foundation/json.js';
import { safeCopyFileSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from '../tool/managed-process.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  createWorkItemIfAbsent,
  describeWorkCoordinationStore,
  getWorkItem,
  listActiveWorkLeases,
  listCoordinationEvents,
  reapExpiredWorkLeases,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';

const initial = {
  itemId: 'durable-item',
  title: 'Durable item',
  description: 'Immutable creation',
  status: 'ready' as const,
  metadata: { request_id: 'request-one' },
};
let namespace: string;
let fixtureRoot: string;
const children: ManagedProcessHandle[] = [];

beforeEach(() => {
  namespace = 'work-coordination-atomic-' + randomUUID();
  setWorkCoordinationNamespace(namespace);
  fixtureRoot = pathResolver.sharedTmp('work-coordination-atomic-' + randomUUID());
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) stopManagedProcess(child.resourceId, child.child);
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

function failAppend(suffix: string): void {
  const io = getFoundationIo();
  const append = io.appendFile.bind(io);
  vi.spyOn(io, 'appendFile').mockImplementation((file, content) => {
    if (file.endsWith(suffix)) throw new Error('simulated process interruption');
    append(file, content);
  });
}

describe('atomic WorkItem ownership', () => {
  it('compares the immutable original creation and returns the latest mutable state', () => {
    const first = createWorkItemIfAbsent(initial);
    updateWorkItem({ itemId: first.item_id, status: 'done', metadata: { result: 'done' } });
    expect(createWorkItemIfAbsent(initial)).toMatchObject({
      version: 2,
      status: 'done',
      metadata: { result: 'done' },
    });
    expect(listCoordinationEvents({ event_type: 'item_created' })).toHaveLength(1);
    expect(() => createWorkItemIfAbsent({ ...initial, metadata: { result: 'done' } })).toThrow(
      /identity conflict/
    );
    expect(() => createWorkItem(initial)).toThrow(/already exists/);
    expect(getWorkItem(initial.itemId)?.status).toBe('done');
  });

  it('uses persisted JSON identity rather than optional undefined fields or key order', () => {
    createWorkItemIfAbsent({ ...initial, metadata: { one: 1, omitted: undefined, two: 2 } });
    expect(createWorkItemIfAbsent({ ...initial, metadata: { two: 2, one: 1 } }).version).toBe(1);
  });

  it('does not adopt an ambiguous legacy ID with more than one creation snapshot', () => {
    const item = createWorkItemIfAbsent(initial);
    const store = describeWorkCoordinationStore();
    safeWriteFile(
      String(store.items_path),
      JSON.stringify(item) + '\n' + JSON.stringify(item) + '\n'
    );
    expect(() => createWorkItemIfAbsent(initial)).toThrow(/identity conflict/);
  });

  it('reuses a committed creation after interruption before the observability append', () => {
    failAppend('/events.jsonl');
    expect(() => createWorkItemIfAbsent(initial)).toThrow(/simulated process interruption/);
    vi.restoreAllMocks();
    expect(createWorkItemIfAbsent(initial)).toMatchObject({ version: 1, status: 'ready' });
    const store = describeWorkCoordinationStore();
    expect(readJsonLines(String(store.items_path))).toHaveLength(1);
  });

  it('fails closed for partial JSONL records rather than adopting an unverifiable ID', () => {
    createWorkItemIfAbsent(initial);
    const io = getFoundationIo();
    io.appendFile(String(describeWorkCoordinationStore().items_path), '{"item_id":');
    expect(() => createWorkItemIfAbsent(initial)).toThrow();
    expect(() =>
      claimWorkItem({
        itemId: initial.itemId,
        actorPeerId: 'peer',
        purpose: 'execute',
        requireNewLease: true,
      })
    ).toThrow();
  });

  it('binds idempotent replay to the actor and forbids replay for executors', () => {
    createWorkItemIfAbsent(initial);
    const input = {
      itemId: initial.itemId,
      actorPeerId: 'peer-one',
      actorUserId: 'user-one',
      purpose: 'execute',
      idempotencyKey: 'same-key',
    };
    const first = claimWorkItem(input);
    expect(claimWorkItem(input).lease.lease_id).toBe(first.lease.lease_id);
    expect(() => claimWorkItem({ ...input, actorPeerId: 'peer-two' })).toThrow(/leased/);
    expect(() => claimWorkItem({ ...input, actorUserId: 'user-two' })).toThrow(/leased/);
    expect(() => claimWorkItem({ ...input, purpose: 'different' })).toThrow(/leased/);
    expect(() => claimWorkItem({ ...input, requireNewLease: true })).toThrow(/leased/);
  });

  it('does not replay a lease committed before a missing item/attempt snapshot', () => {
    createWorkItemIfAbsent(initial);
    failAppend('/items.jsonl');
    const input = {
      itemId: initial.itemId,
      actorPeerId: 'peer-one',
      purpose: 'execute',
      idempotencyKey: 'same-key',
    };
    expect(() => claimWorkItem(input)).toThrow(/simulated process interruption/);
    vi.restoreAllMocks();
    expect(listActiveWorkLeases()).toHaveLength(1);
    expect(getWorkItem(initial.itemId)).toMatchObject({ version: 1, status: 'ready' });
    expect(() => claimWorkItem(input)).toThrow(/leased/);
  });

  it('does not grant fresh execution after a claim committed but its events failed', () => {
    createWorkItemIfAbsent(initial);
    failAppend('/events.jsonl');
    const input = {
      itemId: initial.itemId,
      actorPeerId: 'peer-one',
      purpose: 'execute',
      idempotencyKey: 'same-key',
      requireNewLease: true,
    };
    expect(() => claimWorkItem(input)).toThrow(/simulated process interruption/);
    vi.restoreAllMocks();
    expect(getWorkItem(initial.itemId)).toMatchObject({ version: 2, status: 'in_progress' });
    expect(() => claimWorkItem(input)).toThrow(/leased/);
  });

  it('keeps a terminal item non-executable after interruption before lease release', () => {
    createWorkItemIfAbsent(initial);
    const input = {
      itemId: initial.itemId,
      actorPeerId: 'peer-one',
      purpose: 'execute',
      idempotencyKey: 'same-key',
    };
    const claim = claimWorkItem(input);
    failAppend('/leases.jsonl');
    expect(() =>
      updateWorkItem({
        itemId: initial.itemId,
        expectedVersion: claim.item.version,
        status: 'done',
      })
    ).toThrow(/simulated process interruption/);
    vi.restoreAllMocks();
    expect(getWorkItem(initial.itemId)).toMatchObject({ status: 'done', version: 3 });
    expect(listActiveWorkLeases()).toHaveLength(1);
    expect(() => claimWorkItem(input)).toThrow(/leased/);
    expect(() => claimWorkItem({ ...input, requireNewLease: true })).toThrow(/leased/);
    const reaped = reapExpiredWorkLeases({
      now: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(reaped.recovered).toHaveLength(0);
    expect(listActiveWorkLeases()).toHaveLength(0);
    expect(() => claimWorkItem({ ...input, requireNewLease: true })).toThrow(/terminal/);
  });

  it('refuses to claim completed work even after its lease has been released', () => {
    createWorkItemIfAbsent(initial);
    updateWorkItem({ itemId: initial.itemId, status: 'done' });
    expect(() =>
      claimWorkItem({ itemId: initial.itemId, actorPeerId: 'peer', purpose: 'execute' })
    ).toThrow(/terminal/);
  });

  it.each([
    { append: 'leases', persisted: 'in_progress', recovery: 'replayed' },
    { append: 'items', persisted: 'in_progress', recovery: 'replayed' },
    { append: 'events', persisted: 'done', recovery: 'already_done' },
  ])(
    'recovers durable completion evidence after interruption at $append',
    ({ append, persisted, recovery }) => {
      createWorkItemIfAbsent(initial);
      const { lease, item } = claimWorkItem({
        itemId: initial.itemId,
        actorPeerId: 'peer',
        purpose: 'execute',
      });
      const complete = () =>
        releaseWorkItem({
          itemId: item.item_id,
          actorPeerId: 'peer',
          leaseId: lease.lease_id,
          nextStatus: 'done',
        });
      failAppend('/' + append + '.jsonl');
      expect(complete).toThrow(/simulated process interruption/);
      vi.restoreAllMocks();
      expect(getWorkItem(item.item_id)?.status).toBe(persisted);

      const recoveryInput = {
        now: new Date(Date.parse(lease.expires_at) + 1).toISOString(),
        completedEvidence: (candidate: typeof item) =>
          candidate.item_id === item.item_id &&
          candidate.current_attempt_id === item.current_attempt_id,
      };
      const recovered = reapExpiredWorkLeases(recoveryInput);
      expect(recovered.replayed).toHaveLength(recovery === 'replayed' ? 1 : 0);
      const terminal = getWorkItem(item.item_id);
      expect(terminal?.status).toBe('done');
      expect(listActiveWorkLeases()).toHaveLength(0);
      expect(reapExpiredWorkLeases(recoveryInput).replayed).toEqual([]);
      expect(getWorkItem(item.item_id)).toEqual(terminal);
      expect(complete).toThrow(/lease/i);
    }
  );
});

interface ChildResult {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
  code?: string;
}

function seedChildRoot(): void {
  // Real secure I/O, lock publication and policy catalogs in a disposable root.
  // Children use one canonical package registry; build @agent/core before this suite.
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'work-atomic-fixture', private: true })
    );
    for (const relative of [
      'knowledge/product/schemas/governed-work-item.schema.json',
      'knowledge/product/schemas/workitem-label-taxonomy.schema.json',
      'knowledge/product/governance/security-policy.json',
      'knowledge/product/governance/role-assumption-policy.json',
    ]) {
      safeMkdir(path.dirname(path.join(fixtureRoot, relative)), { recursive: true });
      safeCopyFileSync(pathResolver.rootResolve(relative), path.join(fixtureRoot, relative));
    }
  });
}

async function race(actions: string[], expectedExit = 0): Promise<ChildResult[]> {
  const pending = actions.map((action) => {
    const code = [
      "import * as work from '@agent/core/workforce/work-coordination';",
      "import { getFoundationIo } from '@agent/core/foundation/io';",
      'work.setWorkCoordinationNamespace(' + JSON.stringify(namespace) + ');',
      'const initial = ' + JSON.stringify(initial) + ';',
      "process.stdin.once('data', () => {",
      'try { const value = (() => { ' +
        action +
        ' })(); process.stdout.write(JSON.stringify({ ok: true, value }) + "\\n"); }',
      'catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error), code: error.code }) + "\\n"); }',
      'finally { process.exit(0); }',
      '}); process.stdout.write("READY\\n");',
    ].join('\n');
    const handle = spawnManagedProcess({
      resourceId: 'work-atomic-test-' + randomUUID(),
      kind: 'service',
      ownerId: namespace,
      ownerType: 'test',
      command: process.execPath,
      args: ['--import', 'tsx', '--input-type=module', '-e', code],
      spawnOptions: {
        cwd: pathResolver.rootDir(),
        env: { ...process.env, KYBERION_ROOT: fixtureRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });
    children.push(handle);
    let stdout = '';
    let stderr = '';
    let onReady: () => void;
    let failReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      failReady = reject;
    });
    handle.child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) onReady();
    });
    handle.child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const result = new Promise<ChildResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('child timed out: ' + stderr + stdout);
        failReady(error);
        reject(error);
        stopManagedProcess(handle.resourceId, handle.child);
      }, 30_000);
      handle.child.once('error', (error) => {
        clearTimeout(timer);
        failReady(error);
        reject(error);
      });
      handle.child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== expectedExit) {
          const error = new Error('child failed: ' + stderr + stdout);
          failReady(error);
          reject(error);
          return;
        }
        if (expectedExit !== 0) {
          resolve({ ok: true });
          return;
        }
        const line = stdout
          .trim()
          .split('\n')
          .reverse()
          .find((line) => line.startsWith('{"ok":'));
        if (!line) {
          reject(new Error('missing child result: ' + stdout + stderr));
          return;
        }
        resolve(JSON.parse(line));
      });
    });
    // Attach immediately: a child may fail before every peer reaches the barrier.
    void result.catch(() => undefined);
    return { handle, ready, result };
  });
  await Promise.all(pending.map((child) => child.ready));
  for (const child of pending) child.handle.child.stdin?.end('go\n');
  return Promise.all(pending.map((child) => child.result));
}

describe('real inter-process WorkItem races', () => {
  it('recovers a completion after the writer exits between durable appends', async () => {
    seedChildRoot();
    const [setup] = await race([
      `
      work.createWorkItemIfAbsent(initial);
      return work.claimWorkItem({ itemId: initial.itemId, actorPeerId: 'peer', purpose: 'execute' }).item;
    `,
    ]);
    expect(setup.ok, setup.error).toBe(true);
    expect(setup.value?.current_attempt_id).toEqual(expect.any(String));
    const [interrupted] = await race(
      [
        `
        const io = getFoundationIo();
        const append = io.appendFile.bind(io);
        io.appendFile = (file, content) => {
          if (file.endsWith('/items.jsonl')) process.exit(42);
          return append(file, content);
        };
        return work.releaseWorkItem({
          itemId: initial.itemId, actorPeerId: 'peer', leaseId: ${JSON.stringify(setup.value?.lease_id)}, nextStatus: 'done'
        });
      `,
      ],
      42
    );
    expect(interrupted.ok).toBe(true);
    const [restarted] = await race([
      `
      const before = work.getWorkItem(initial.itemId);
      const completedEvidence = (item) => item.item_id === initial.itemId &&
        item.current_attempt_id === ${JSON.stringify(setup.value?.current_attempt_id)};
      const first = work.reapExpiredWorkLeases({ completedEvidence });
      const second = work.reapExpiredWorkLeases({ completedEvidence });
      return { before: before.status, first: first.replayed.length, second: second.replayed.length,
        after: work.getWorkItem(initial.itemId).status, liveLeases: work.listActiveWorkLeases().length };
    `,
    ]);
    expect(restarted.ok, restarted.error).toBe(true);
    expect(restarted.value).toEqual({
      before: 'in_progress',
      first: 1,
      second: 0,
      after: 'done',
      liveLeases: 0,
    });
  }, 60_000);

  it('rejects stale completion regardless of ordering against current completion', async () => {
    seedChildRoot();
    const [setup] = await race([
      `
      work.createWorkItemIfAbsent(initial);
      const claim = (actorPeerId) => work.claimWorkItem({
        itemId: initial.itemId, actorPeerId, purpose: 'execute'
      }).lease;
      const previous = claim('peer-a');
      work.reapExpiredWorkLeases({ now: new Date(Date.parse(previous.expires_at) + 1).toISOString() });
      return { previous: previous.lease_id, current: claim('peer-b').lease_id };
    `,
    ]);
    expect(setup.ok, setup.error).toBe(true);
    const complete = (actor: string, lease: unknown) => `
      return work.releaseWorkItem({
        itemId: initial.itemId, actorPeerId: ${JSON.stringify(actor)},
        leaseId: ${JSON.stringify(lease)}, nextStatus: 'done'
      });
    `;
    const [stale, current] = await race([
      complete('peer-a', setup.value?.previous),
      complete('peer-b', setup.value?.current),
    ]);
    expect(stale.ok).toBe(false);
    expect(['lease_conflict', 'lease_not_found']).toContain(stale.code);
    expect(current.ok, current.error).toBe(true);
    expect(current.value?.item).toMatchObject({ status: 'done', version: 5 });
    const snapshots = readJsonLines<{ status: string; version: number }>(
      path.join(fixtureRoot, 'active/shared/runtime/work-coordination', namespace, 'items.jsonl')
    );
    expect(snapshots.filter((item) => item.status === 'done').map((item) => item.version)).toEqual([
      5,
    ]);
  }, 60_000);

  it('creates one original snapshot under simultaneous equivalent creates', async () => {
    seedChildRoot();
    const results = await race(
      Array.from({ length: 4 }, () => 'return work.createWorkItemIfAbsent(initial);')
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const snapshots = readJsonLines(
      path.join(fixtureRoot, 'active/shared/runtime/work-coordination', namespace, 'items.jsonl')
    );
    expect(snapshots).toHaveLength(1);
    expect(new Set(results.map((result) => result.value?.created_at)).size).toBe(1);
  }, 60_000);

  it('allows one executor even when actor and idempotency key are identical', async () => {
    seedChildRoot();
    expect((await race(['return work.createWorkItemIfAbsent(initial);']))[0].ok).toBe(true);
    const claim =
      'return work.claimWorkItem({ itemId: initial.itemId, actorPeerId: "same-peer", purpose: "execute", idempotencyKey: "same-key", requireNewLease: true });';
    const results = await race([claim, claim, claim, claim]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.code === 'version_conflict' || result.code === 'lease_conflict')
    ).toBe(true);
    const snapshots = readJsonLines<{ version: number; attempts?: unknown[] }>(
      path.join(fixtureRoot, 'active/shared/runtime/work-coordination', namespace, 'items.jsonl')
    );
    expect(snapshots.map((item) => item.version)).toEqual([1, 2]);
    expect(snapshots[1].attempts).toHaveLength(1);
  }, 60_000);

  it('rejects a simultaneous create with a different immutable request identity', async () => {
    seedChildRoot();
    const results = await race([
      'return work.createWorkItemIfAbsent(initial);',
      'return work.createWorkItemIfAbsent({ ...initial, metadata: { request_id: "request-two" } });',
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.code).toBe('idempotency_conflict');
    const snapshots = readJsonLines(
      path.join(fixtureRoot, 'active/shared/runtime/work-coordination', namespace, 'items.jsonl')
    );
    expect(snapshots).toHaveLength(1);
  }, 60_000);

  it('serializes claim against a competing versioned updater', async () => {
    seedChildRoot();
    await race(['return work.createWorkItemIfAbsent(initial);']);
    const results = await race([
      'return work.claimWorkItem({ itemId: initial.itemId, actorPeerId: "peer", purpose: "execute", requireNewLease: true, expectedVersion: 1 });',
      'return work.updateWorkItem({ itemId: initial.itemId, expectedVersion: 1, status: "done" });',
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.code).toBe('version_conflict');
    const snapshots = readJsonLines<{ version: number }>(
      path.join(fixtureRoot, 'active/shared/runtime/work-coordination', namespace, 'items.jsonl')
    );
    expect(snapshots.map((item) => item.version)).toEqual([1, 2]);
  }, 60_000);
});
