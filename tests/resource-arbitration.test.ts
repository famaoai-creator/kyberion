import { describe, it, expect, beforeAll } from 'vitest';
import { withLock, safeWriteFile, safeReadFile, safeExistsSync, pathResolver, safeUnlinkSync } from '@agent/core';
import * as path from 'node:path';

const TEST_RESOURCE = 'test-resource-arbitration';
const TEST_FILE = pathResolver.rootResolve('scratch/lock-test.txt');

describe('Autonomous Resource Arbitration (Locking)', () => {
  
  beforeAll(() => {
    if (safeExistsSync(TEST_FILE)) safeUnlinkSync(TEST_FILE);
  });

  it('Scenario: Concurrent access arbitration', async () => {
    let executionOrder: string[] = [];

    const task1 = async () => {
      await withLock(TEST_RESOURCE, async () => {
        executionOrder.push('task1-start');
        await new Promise(res => setTimeout(res, 500)); // Simulate work
        safeWriteFile(TEST_FILE, 'Task 1 Content');
        executionOrder.push('task1-end');
      });
    };

    const task2 = async () => {
      // Small delay to ensure task1 starts first
      await new Promise(res => setTimeout(res, 100));
      await withLock(TEST_RESOURCE, async () => {
        executionOrder.push('task2-start');
        const content = safeReadFile(TEST_FILE, { encoding: 'utf8' });
        executionOrder.push(`task2-read-${content}`);
        executionOrder.push('task2-end');
      });
    };

    // Run concurrently
    await Promise.all([task1(), task2()]);

    // Verify sequential execution due to lock
    expect(executionOrder).toEqual([
      'task1-start',
      'task1-end',
      'task2-start',
      'task2-read-Task 1 Content',
      'task2-end'
    ]);
  });

  it('Scenario: Lock timeout handling', async () => {
    // Hold lock indefinitely in background
    await acquirePersistentLock();
    
    try {
      await withLock(TEST_RESOURCE, async () => {
        throw new Error('Should not be reached');
      }, 1000); // Short timeout
      throw new Error('Lock should have timed out');
    } catch (err: any) {
      expect(err.message).toContain('[LOCK_TIMEOUT]');
    }
  });
});

async function acquirePersistentLock() {
    const { acquireLock } = await import('@agent/core');
    await acquireLock(TEST_RESOURCE, 1000);
}
