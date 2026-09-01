import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { assertDesktopPipelineResourcePath, loadDesktopPipeline } from './desktop-pipeline.js';

const root = pathResolver.rootResolve(`active/shared/tmp/desktop-pipeline-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('desktop pipeline trust boundary', () => {
  it('rejects project-local pipeline content before trust resolution', () => {
    const result = loadDesktopPipeline('pipelines/desktop/example.json', {
      trustResolved: false,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      '[TRUST_REQUIRED] project-local desktop pipeline cannot be loaded before trust resolution',
    ]);
  });

  it('keeps allowlist validation ahead of the trust boundary', () => {
    const result = loadDesktopPipeline('../pipelines/desktop/example.json', {
      trustResolved: false,
    });

    expect(result.errors).toEqual(['desktop pipeline_ref is not allowlisted']);
  });

  it('fails closed when project trust is omitted', () => {
    const result = loadDesktopPipeline('pipelines/desktop/example.json');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      '[TRUST_REQUIRED] project-local desktop pipeline cannot be loaded before trust resolution',
    ]);
  });

  it('rejects a symlinked pipeline after trust resolution', () => {
    const desktopRoot = pathResolver.rootResolve(`${root}/desktop`);
    const outside = pathResolver.rootResolve(`${root}/outside`);
    const link = pathResolver.rootResolve(`${root}/desktop/linked.json`);
    safeMkdir(desktopRoot, { recursive: true });
    safeMkdir(outside, { recursive: true });
    safeWriteFile(pathResolver.rootResolve(`${root}/outside/pipeline.json`), '{}');
    safeSymlinkSync(pathResolver.rootResolve(`${root}/outside/pipeline.json`), link);

    expect(() => assertDesktopPipelineResourcePath(link, desktopRoot)).toThrow(
      '[DESKTOP_PIPELINE_SCOPE]'
    );
  });
});
