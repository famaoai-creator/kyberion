import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { MAX_FACTS } from '@agent/core/memory-notebook';
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

  it('keeps read and promotion paths inside active volatile storage', async () => {
    await expect(
      handleAction({ action: 'read', params: { mdPath: pathResolver.rootResolve('package.json') } })
    ).rejects.toThrow(/active/u);
    await expect(
      handleAction({
        action: 'nominate-promotion',
        params: {
          mdPath: pathResolver.rootResolve('package.json'),
          evidence_refs: ['active/package.json'],
        },
      })
    ).rejects.toThrow(/active/u);
  });

  it('rejects traversal-shaped daily and weekly period keys', async () => {
    await expect(
      handleAction({ action: 'daily-open', params: { date: '../confidential/escape' } })
    ).rejects.toThrow(/invalid daily period/u);
    await expect(
      handleAction({ action: 'todo-rollover', params: { date: '../../escape' } })
    ).rejects.toThrow(/invalid daily period/u);
    await expect(
      handleAction({ action: 'weekly-open', params: { weekKey: '../escape' } })
    ).rejects.toThrow(/invalid weekly period/u);
  });

  it('reports the consolidation threshold without mutating the notebook', async () => {
    for (let index = 0; index < 10; index += 1) {
      await handleAction({
        action: 'note',
        params: { scope: 'session', scope_ref: TEST_SCOPE_REF, content: `fact ${index}` },
      });
    }
    const mdPath = `${TEST_ROOT}/MEMORY.md`;
    const result = (await handleAction({
      action: 'consolidation-status',
      params: { mdPath },
    })) as { working_memory_result: { due: boolean; bullet_count: number; threshold: number } };
    expect(result.working_memory_result).toMatchObject({
      due: true,
      bullet_count: 10,
      threshold: 10,
    });
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

    it('drops the oldest notes when the shared notebook limit is exceeded', async () => {
      for (let index = 0; index < MAX_FACTS + 2; index += 1) {
        await note(`bounded fact ${index}`);
      }
      const body = read();
      const facts = body.split('\n').filter((line) => line.startsWith('- '));
      expect(facts).toHaveLength(MAX_FACTS);
      expect(facts.some((line) => line.endsWith('bounded fact 0'))).toBe(false);
      expect(facts.some((line) => line.endsWith('bounded fact 1'))).toBe(false);
      expect(body).toContain(`bounded fact ${MAX_FACTS + 1}`);
    });
  });
});
