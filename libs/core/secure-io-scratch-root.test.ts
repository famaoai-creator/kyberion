import { describe, it, expect, vi } from 'vitest';
import { safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(() => {
      throw new Error('unexpected native removal');
    }),
  };
});
import * as fs from 'node:fs';
describe('shared scratch root removal guard', () => {
  it.each([
    'active/shared/tmp',
    pathResolver.rootResolve('active/shared/tmp'),
    'active/shared/tmp/',
    'active/shared/tmp/job/..',
  ])('rejects recursive root removal before native filesystem calls: %s', (target) => {
    withExecutionContext('infrastructure_sentinel', () =>
      expect(() => safeRmSync(target, { recursive: true, force: true })).toThrow(
        'scratch_root_removal_denied'
      )
    );
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
  it('protects the default recursive options too', () => {
    withExecutionContext('infrastructure_sentinel', () =>
      expect(() => safeRmSync('active/shared/tmp')).toThrow('scratch_root_removal_denied')
    );
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});
