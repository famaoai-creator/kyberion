import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('kyberion home procedure inspection trust boundary', () => {
  it('does not bypass project trust while inspecting desktop pipelines', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('loadDesktopPipeline(entry.pipeline_ref, { trustResolved: false })');
    expect(source).not.toContain(
      'loadDesktopPipeline(entry.pipeline_ref, { trustResolved: true })'
    );
  });
});
