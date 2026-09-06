import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './summarize_memory_promotion_queue.js';

describe('memory promotion queue summary entrypoint', () => {
  it('keeps report output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/summarize_memory_promotion_queue.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result.output)');
    expect(source).toContain('assertSafeRepositoryPath(');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without reading or writing the promotion queue', () => {
    expect(main(['--help'])).toEqual({
      help: expect.stringContaining('memory:summarize-promotion-queue'),
    });
  });
});
