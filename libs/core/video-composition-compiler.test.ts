import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { compileVideoCompositionADF, writeVideoCompositionBundle } from './video-composition-compiler.js';
import type { VideoCompositionADF } from './video-composition-contract.js';

describe('video composition compiler', () => {
  it('compiles render plans and writes bundle artifacts', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/product-explainer');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      intent: 'Product explainer',
      title: 'Product explainer',
      composition: {
        duration_sec: 8,
        fps: 30,
        width: 1920,
        height: 1080,
        background_color: '#081225',
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 3,
          template_ref: { template_id: 'basic-title-card' },
          content: {
            headline: 'Explain the product clearly',
            body: 'Deterministic scenes complement model-generated video clips.',
          },
        },
        {
          scene_id: 'proof',
          role: 'proof',
          start_sec: 3,
          duration_sec: 5,
          template_ref: { template_id: 'split-highlight' },
          content: {
            headline: 'Structured scenes',
            body: 'Scene templates stay governed and reusable.',
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: bundleDir,
        emit_progress_packets: true,
      },
    };

    const plan = compileVideoCompositionADF(adf);
    expect(plan.scenes).toHaveLength(2);
    expect(plan.output_format).toBe('mp4');

    const written = writeVideoCompositionBundle(adf);
    expect(written.bundle_dir).toBe(bundleDir);
    expect(safeExistsSync(`${bundleDir}/index.html`)).toBe(true);
    expect(safeExistsSync(`${bundleDir}/render-plan.json`)).toBe(true);
    expect(safeReadFile(`${bundleDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain('Explain the product clearly');
  });
});
