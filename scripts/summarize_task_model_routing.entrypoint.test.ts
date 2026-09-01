import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './summarize_task_model_routing.js';

describe('task model routing summary entrypoint', () => {
  it('keeps report output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/summarize_task_model_routing.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result.output)');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without loading task or supervisor events', () => {
    expect(main(['--help'])).toEqual({
      help: expect.stringContaining('task:summarize-model-routing'),
    });
  });
});
