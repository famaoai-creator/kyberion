import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: string[] = [];
const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeAppendFileSync: vi.fn((target: string, data: string | Buffer) => {
    if (target.endsWith('mock_blockchain.jsonl')) {
      writes.push(String(data));
    }
  }),
  safeMkdir: vi.fn(),
  safeExistsSync: vi.fn(
    (target: string) => target.endsWith('mock_blockchain.jsonl') || target.endsWith('manifest.json')
  ),
  pathResolver: {
    active: vi.fn((relPath: string) => `/repo/active/${relPath}`),
    rootResolve: vi.fn((relPath: string) => `/repo/${relPath}`),
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  createStandardYargs: vi.fn(() => ({
    option: vi.fn().mockReturnThis(),
    parseSync: vi.fn(() => ({ input: 'input.json' })),
  })),
  classifyError: vi.fn(() => ({ category: 'resource_unavailable' })),
  withRetry: vi.fn(async (fn: () => Promise<void> | void) => await fn()),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<any>('@agent/core');
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeAppendFileSync: mocks.safeAppendFileSync,
    safeMkdir: mocks.safeMkdir,
    safeExistsSync: mocks.safeExistsSync,
    pathResolver: mocks.pathResolver,
    logger: mocks.logger,
    createStandardYargs: mocks.createStandardYargs,
    classifyError: mocks.classifyError,
    withRetry: mocks.withRetry,
  };
});

import { handleAction } from './index.js';

describe('blockchain-actuator behavior', () => {
  beforeEach(() => {
    writes.length = 0;
    mocks.safeReadFile.mockImplementation((target: string) => {
      if (target.endsWith('manifest.json')) {
        return JSON.stringify({
          recovery_policy: {
            retry: {
              maxRetries: 2,
              initialDelayMs: 500,
              maxDelayMs: 5000,
              factor: 2,
              jitter: true,
            },
            retryable_categories: ['resource_unavailable'],
          },
        });
      }
      if (target.endsWith('mock_blockchain.jsonl')) {
        return writes.join('');
      }
      return '';
    });
  });

  it('anchors missions in simulated mode', async () => {
    const result = await handleAction({
      action: 'anchor_mission',
      params: {
        mission_id: 'mission-1',
        hash: 'sha256:abc123',
      },
    });

    expect(result).toMatchObject({
      status: 'success',
      simulated: true,
    });
    expect(writes.join('')).toContain('"type":"MISSION_ANCHOR"');
  });

  it('verifies mission anchors in simulated mode', async () => {
    await handleAction({
      action: 'anchor_mission',
      params: {
        mission_id: 'mission-2',
        hash: 'sha256:def456',
      },
    });

    const result = await handleAction({
      action: 'verify_anchor',
      params: {
        mission_id: 'mission-2',
        hash: 'sha256:def456',
      },
    });

    expect(result).toMatchObject({
      status: 'verified',
      simulated: true,
      verified: true,
    });
  });
});
