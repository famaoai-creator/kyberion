import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './kyberion_home.js';

describe('kyberion home procedure inspection trust boundary', () => {
  it('uses the governed object parser for procedure inputs', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain("parseSafeJsonObjectInput(raw, 'procedure inputs')");
    expect(source).not.toContain('JSON.parse(argv.inputs)');
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
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

  it('routes home help output and failures through the supplied printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('return main(context.argv, context.print);');

    const previousRole = process.env.MISSION_ROLE;
    const output: unknown[] = [];
    try {
      await main(['--help'], (value) => output.push(value));
      expect(output).toHaveLength(59);
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });
});
