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
    rootDir: vi.fn(() => '/repo'),
    active: vi.fn((relPath: string) => `/repo/active/${relPath}`),
    rootResolve: vi.fn((relPath: string) => `/repo/${relPath}`),
    knowledge: vi.fn((relPath: string) => `/repo/knowledge/${relPath}`),
    shared: vi.fn((relPath = '') => `/repo/active/shared/${relPath}`),
    resolve: vi.fn((relPath: string) => relPath),
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
  createStandardYargs: vi.fn(() => ({
    option: vi.fn().mockReturnThis(),
    parseSync: vi.fn(() => ({ input: 'input.json' })),
  })),
  classifyError: vi.fn(() => ({ category: 'resource_unavailable' })),
  retry: vi.fn(async (fn: () => Promise<void> | void) => await fn()),
}));

vi.mock('@agent/core/foundation', () => ({
  appendJsonLine: vi.fn((_target: string, data: string) => {
    writes.push(JSON.stringify(data));
  }),
  parseSafeJsonInput: vi.fn((input: string) => JSON.parse(input)),
}));

vi.mock('@agent/core/core', () => ({ logger: mocks.logger }));
vi.mock('@agent/core/secure-io', () => ({
  safeReadFile: mocks.safeReadFile,
  safeMkdir: mocks.safeMkdir,
  safeExistsSync: mocks.safeExistsSync,
  assertSafeRepositoryPath: vi.fn((candidate: string) => candidate),
}));
vi.mock('@agent/core/path-resolver', () => ({
  ...mocks.pathResolver,
  pathResolver: mocks.pathResolver,
}));
vi.mock('@agent/core/async-utils', () => ({ retry: mocks.retry }));

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
