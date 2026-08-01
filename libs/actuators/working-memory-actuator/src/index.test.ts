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

  describe('QM-03 notebook fold semantics', () => {
    const note = (content: string, extra: Record<string, unknown> = {}) =>
      handleAction({
        action: 'note',
        params: { scope: 'session', scope_ref: TEST_SCOPE_REF, content, ...extra },
      });
    const mdPath = `${TEST_ROOT}/MEMORY.md`;
    const read = () => String(safeReadFile(mdPath, { encoding: 'utf8' }));

    it('date-stamps notes and dedupes by normalized text', async () => {
      await note('User prefers vim');
      const result = (await note('user prefers VIM')) as {
        working_memory_result: { deduped?: boolean };
      };
      expect(result.working_memory_result.deduped).toBe(true);
      const body = read();
      expect(body.match(/prefers vim/gi)).toHaveLength(1);
      expect(body).toMatch(/- \(\d{4}-\d\d-\d\d\) User prefers vim/);
    });

    it('neutralizes untrusted provenance but keeps trusted notes verbatim', async () => {
      await note('likes tea (said in #private)');
      expect(read()).toContain('[claimed source: #private]');
      await note('likes coffee (said in #general)', { trusted: true });
      expect(read()).toContain('likes coffee (said in #general)');
    });
  });
});
