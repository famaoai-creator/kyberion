import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
import { handleAction } from './index.js';

const TEST_SCOPE_REF = 'working-memory-actuator-test';
const TEST_ROOT = pathResolver.shared(`runtime/session/${TEST_SCOPE_REF}`);

afterEach(() => {
  if (safeExistsSync(TEST_ROOT)) {
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

describe('working-memory-actuator', () => {
  it('writes a session note', async () => {
    const result = await handleAction({
      action: 'note',
      params: {
        scope: 'session',
        scope_ref: TEST_SCOPE_REF,
        content: 'baseline note',
      },
    });

    const mdPath = `${TEST_ROOT}/MEMORY.md`;
    expect(result).toEqual(
      expect.objectContaining({
        working_memory_result: expect.objectContaining({
          path: mdPath,
        }),
      })
    );
    expect(safeExistsSync(mdPath)).toBe(true);
    expect(String(safeReadFile(mdPath, { encoding: 'utf8' }))).toContain('baseline note');
  });

  it('rejects unknown operations', async () => {
    await expect(
      handleAction({
        action: 'working-memory:unknown-op',
        params: {},
      })
    ).rejects.toThrow('working-memory-actuator: unknown op "working-memory:unknown-op"');
  });
});
