import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from '@agent/core/memory-promotion-queue';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { listMemoryQueue } from './refactor/mission-memory-commands.js';
import { ScriptExitError } from './lib/harness.js';

// Isolate this suite's queue reads from the repository's real (gitignored,
// ambient) runtime queue, matching the documented override used by
// libs/core/memory-promotion-queue.test.ts.
const TEST_QUEUE_PATH =
  'active/shared/tmp/test-memory-queue-mission-memory-commands-entrypoint.jsonl';

describe('mission memory command output boundary', () => {
  beforeEach(() => {
    process.env.KYBERION_MEMORY_QUEUE_PATH = TEST_QUEUE_PATH;
  });

  afterEach(() => {
    delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    const queuePath = pathResolver.rootResolve(TEST_QUEUE_PATH);
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
  });

  it('keeps memory command output away from direct console streams', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/refactor/mission-memory-commands.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('print: Print');
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("registeredEnv('MISSION_ID')");
  });

  it('routes the queue table through the supplied printer', () => {
    enqueueMemoryPromotionCandidate(
      createMemoryPromotionCandidate({
        sourceType: 'mission',
        sourceRef: 'mission:MSN-TEST-ENTRYPOINT-QUEUE',
        proposedMemoryKind: 'sop',
        summary: 'Promote a repeatable entrypoint-test flow.',
        evidenceRefs: ['artifact:ART-TEST-ENTRYPOINT-QUEUE'],
        sensitivityTier: 'public',
      })
    );
    const output: unknown[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      listMemoryQueue('queued', (value) => output.push(value));
      expect(output[0]).toBe('');
      expect(String(output[1])).toContain('CANDIDATE_ID');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns memory command failures through the governed script error', async () => {
    const { approveMemoryCandidate, promoteMemoryCandidate } =
      await import('./refactor/mission-memory-commands.js');

    expect(() => approveMemoryCandidate('')).toThrowError(ScriptExitError);
    await expect(promoteMemoryCandidate('')).rejects.toBeInstanceOf(ScriptExitError);
  });
});
