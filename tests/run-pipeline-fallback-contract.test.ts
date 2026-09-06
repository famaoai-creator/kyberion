import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('run_pipeline fallback contract', () => {
  it('uses the shared harness for the compiled pipeline entrypoint', () => {
    const source = String(safeReadFile('scripts/run_pipeline.ts', { encoding: 'utf8' }) || '');

    expect(source).toContain("defineScript({\n    name: 'pipeline'");
    expect(source).not.toContain('.catch((err)');
    expect(source).not.toContain('process.exitCode');
  });

  it('spawns the fallback pipeline from the project root path resolver', () => {
    // The fallback implementation lives in the execution bootstrap module;
    // run_pipeline.ts is only the public entrypoint after the refactor.
    const source = String(
      safeReadFile('scripts/pipeline-execution-part-bootstrap.ts', { encoding: 'utf8' }) || ''
    );

    expect(source).toContain(
      "const fallbackEntry = pathResolver.rootResolve('scripts/run_pipeline.ts');"
    );
    expect(source).toContain(
      "const args = ['--import', 'tsx', fallbackEntry, '--input', fallbackPath];"
    );
    expect(source).toContain("return safeExecResult('node', args, {");
    expect(source).toContain('cwd: pathResolver.rootDir(),');
    expect(
      source.includes("pnpm', ['exec', 'tsx', 'scripts/run_pipeline.ts', '--input', fallbackPath]")
    ).toBe(false);
  });
});
