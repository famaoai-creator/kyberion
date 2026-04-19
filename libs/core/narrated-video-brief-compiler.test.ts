import { describe, expect, it } from 'vitest';
import { compileNarratedVideoBriefToCompositionADF } from './narrated-video-brief-compiler.js';

describe('narrated video brief compiler', () => {
  it('compiles narrated brief into a video-composition-adf', () => {
    const adf = compileNarratedVideoBriefToCompositionADF({
      kind: 'narrated-video-brief',
      version: '1.0.0',
      language: 'ja',
      script: {
        hook: 'Intent to Execution',
        feature: 'Contracts connect planning, execution, and evidence.',
        cta: 'Operate with Kyberion.',
      },
      narration: {
        artifact_ref: 'active/shared/exports/narration.aiff',
      },
      design_system: {
        brand_name: 'Kyberion',
        theme_tokens: {
          background_color: '#07111f',
        },
        assets: {
          logo_path: 'active/shared/assets/logo.png',
          hero_path: 'active/shared/assets/hero.png',
        },
      },
      output: {
        format: 'mp4',
      },
    });

    expect(adf.kind).toBe('video-composition-adf');
    expect(adf.audio?.narration_ref).toBe('active/shared/exports/narration.aiff');
    expect(adf.scenes.length).toBe(3);
    expect(adf.scenes[0].template_ref.template_id).toBe('basic-title-card');
    expect(adf.scenes[1].template_ref.template_id).toBe('split-highlight');
    expect(adf.scenes[2].template_ref.template_id).toBe('logo-outro');
    expect(adf.output.format).toBe('mp4');
  });
});
