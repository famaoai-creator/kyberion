import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './run_intent.js';

describe('intent gateway entrypoint', () => {
  it('uses the canonical resolver and shared output harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_intent.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('resolveIntentResolutionPacket');
    expect(source).toContain('print(result)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('logger.success(');
    expect(source).not.toContain('logger.warn(');
  });

  it('handles help without bootstrapping or executing an intent', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 'help',
      usage: expect.stringContaining('intent:run'),
    });
  });
});
