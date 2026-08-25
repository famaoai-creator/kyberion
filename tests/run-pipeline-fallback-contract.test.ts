import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('run_pipeline fallback contract', () => {
  it('spawns the fallback pipeline from the project root path resolver', () => {
    // The fallback implementation lives in the execution bootstrap module;
    // run_pipeline.ts is only the public entrypoint after the refactor.
    const source = String(
      safeReadFile('scripts/pipeline-execution-part-bootstrap.ts', { encoding: 'utf8' }) || ''
    );

    const fallbackSnippet = source.match(
      /KYBERION_PIPELINE_FALLBACK_ACTIVE[\s\S]{0,500}node[\s\S]{0,120}--import[\s\S]{0,120}tsx[\s\S]{0,300}cwd:\s*pathResolver\.rootDir\(\)/
    );

    expect(fallbackSnippet).not.toBeNull();
    expect(
      source.includes("pnpm', ['exec', 'tsx', 'scripts/run_pipeline.ts', '--input', fallbackPath]")
    ).toBe(false);
  });
});
