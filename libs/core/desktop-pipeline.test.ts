import { describe, expect, it } from 'vitest';
import { loadDesktopPipeline } from './desktop-pipeline.js';

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
});
