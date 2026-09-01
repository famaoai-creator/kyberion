import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('kyberion home procedure inspection trust boundary', () => {
  it('uses the governed object parser for procedure inputs', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain("parseSafeJsonObjectInput(raw, 'procedure inputs')");
    expect(source).not.toContain('JSON.parse(argv.inputs)');
  });

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
