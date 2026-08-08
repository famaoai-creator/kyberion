import { afterEach, describe, expect, it } from 'vitest';
import {
  armWatch,
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from './managed-process.js';
import { armTriggerWatch, TriggerRunner } from './trigger-runner.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeUnlinkSync } from './secure-io.js';
import { randomUUID } from 'node:crypto';

describe('managed process watch (QM-02)', () => {
  let handle: ManagedProcessHandle | null = null;
  let triggerStore: string | null = null;

  afterEach(() => {
    if (handle) stopManagedProcess(handle.resourceId, handle.child);
    handle = null;
    if (triggerStore && safeExistsSync(triggerStore)) safeUnlinkSync(triggerStore);
    triggerStore = null;
  });

  it('emits a bounded output trigger and keeps the watch on the managed process', async () => {
    handle = spawnManagedProcess({
      resourceId: 'qm02-watch-test',
      kind: 'service',
      ownerId: 'qm02-test',
      ownerType: 'test',
      command: process.execPath,
      args: ['-e', "console.log('qm02-ready'); setTimeout(() => {}, 250);"],
      spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
    });

    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watch timed out')), 2_000);
      armWatch(handle!.resourceId, {
        outputRegex: /qm02-ready/u,
        maxTailBytes: 1024,
        onEvent: (event) => {
          if (event.kind !== 'output') return;
          clearTimeout(timer);
          resolve(event.tail);
        },
      });
    });

    expect(output).toContain('qm02-ready');
  });

  it('reports a lost process instead of throwing or spawning a replacement', async () => {
    const events: string[] = [];
    armWatch('qm02-missing-process', {
      onEvent: (event) => events.push(event.kind),
    });
    expect(events).toEqual(['lost']);
  });

  it('emits quiet once until the process produces more output', async () => {
    handle = spawnManagedProcess({
      resourceId: 'qm02-quiet-test',
      kind: 'service',
      ownerId: 'qm02-test',
      ownerType: 'test',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 180);'],
      spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
    });
    let quietCount = 0;
    const watch = armWatch(handle.resourceId, {
      quietMs: 20,
      minTriggerIntervalMs: 0,
      onEvent: (event) => {
        if (event.kind === 'quiet') quietCount += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    watch.stop();
    expect(quietCount).toBe(1);
  });

  it('delivers watch events through TriggerRunner', async () => {
    triggerStore = pathResolver.sharedTmp(`qm02-watch-trigger-${randomUUID()}.jsonl`);
    const runner = new TriggerRunner({
      storePath: triggerStore,
      authorityResolver: (snapshot) => snapshot,
    });
    handle = spawnManagedProcess({
      resourceId: 'qm02-trigger-watch-test',
      kind: 'service',
      ownerId: 'qm02-test',
      ownerType: 'test',
      command: process.execPath,
      args: ['-e', "console.log('qm02-trigger-ready'); setTimeout(() => {}, 250);"],
      spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
    });
    const deliveries: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('trigger watch timed out')), 2_000);
      armTriggerWatch(handle!.resourceId, {
        runner,
        idempotencyPrefix: 'qm02-process',
        outputRegex: /qm02-trigger-ready/u,
        createdBy: { authority_role: 'chronos_gateway', level: 40 },
        deliver: (input) => {
          deliveries.push(input.idempotencyKey);
          clearTimeout(timer);
          resolve();
          return input.idempotencyKey;
        },
      });
    });
    expect(deliveries).toHaveLength(1);
    expect(runner.records()[0]?.source).toBe('watch');
  });
});
