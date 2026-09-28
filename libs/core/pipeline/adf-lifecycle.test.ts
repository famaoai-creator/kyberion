import { describe, expect, it } from 'vitest';
import { runAdfLifecycle } from './adf-lifecycle.js';

describe('runAdfLifecycle', () => {
  it('repairs before retrying preflight and only then executes', async () => {
    const calls: string[] = [];
    const result = await runAdfLifecycle({
      draft: () => {
        calls.push('draft');
        return { valid: false };
      },
      preflight: (draft) => {
        calls.push(`preflight:${draft.valid}`);
        if (!draft.valid) throw new Error('invalid');
        return draft;
      },
      autoRepair: (draft) => {
        calls.push('auto-repair');
        return { ...draft, valid: true };
      },
      commit: (prepared) => {
        calls.push('commit');
        return prepared;
      },
      execute: (committed) => {
        calls.push('execute');
        return committed.valid;
      },
    });

    expect(result.result).toBe(true);
    expect(calls).toEqual([
      'draft',
      'preflight:false',
      'auto-repair',
      'preflight:true',
      'commit',
      'execute',
    ]);
    expect(result.phases.map((phase) => phase.phase)).toEqual([
      'draft',
      'auto-repair',
      'preflight',
      'commit',
      'execute',
    ]);
  });

  it('does not execute when preflight fails without a repair hook', async () => {
    await expect(
      runAdfLifecycle({
        draft: () => ({}),
        preflight: () => {
          throw new Error('blocked');
        },
        commit: () => 'never',
        execute: () => 'never',
      })
    ).rejects.toThrow('blocked');
  });
});
