import { describe, expect, it } from 'vitest';
import { compileNarratedVideoBriefToCompositionADF } from './narrated-video-brief-compiler.js';

describe('narrated video brief compiler', () => {
  it('compiles narrated brief into a video-composition-adf', () => {
    const adf = compileNarratedVideoBriefToCompositionADF({
      kind: 'narrated-video-brief',
      version: '1.0.0',
      language: 'ja',
      storyboard: {
        kind: 'video-storyboard',
        version: '1.0.0',
        content_type: 'howto',
        presentation_mode: 'howto',
        format: { width: 1920, height: 1080 },
        beats: [
          {
            beat_id: 'hook',
            title: 'Hook',
            start_sec: 0,
            duration_sec: 4,
            role: 'hook',
            semantic: 'hook',
            message: 'Intent',
            visual_direction: 'Open with intent',
          },
          {
            beat_id: 'process',
            title: 'Process',
            start_sec: 4,
            duration_sec: 4,
            role: 'feature',
            semantic: 'process',
            message: 'Process',
            visual_direction: 'Show the process',
          },
          {
            beat_id: 'proof',
            title: 'Proof',
            start_sec: 8,
            duration_sec: 4,
            role: 'proof',
            semantic: 'proof',
            message: 'Proof',
            visual_direction: 'Show proof',
          },
        ],
      },
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
    expect(adf.scenes[1].template_ref.template_id).toBe('howto-guide');
    expect(adf.scenes[2].template_ref.template_id).toBe('logo-outro');
    expect(adf.output.format).toBe('mp4');
  });

  it('compiles a storyboard-backed narrated brief into variable scenes', () => {
    const adf = compileNarratedVideoBriefToCompositionADF({
      kind: 'narrated-video-brief',
      version: '1.0.0',
      language: 'ja',
      storyboard: {
        kind: 'video-storyboard',
        version: '1.0.0',
        content_type: 'promo',
        presentation_mode: 'promo',
        format: { width: 1920, height: 1080 },
        title: 'Storyboard backed',
        beats: [
          {
            beat_id: 'brief',
            title: 'Brief intake',
            start_sec: 0,
            duration_sec: 4,
            role: 'hook',
            semantic: 'hook',
            message: 'Receive the brief.',
            visual_direction: 'Show the brief intake.',
          },
          {
            beat_id: 'process',
            title: 'Content plan',
            start_sec: 4,
            duration_sec: 4,
            role: 'feature',
            semantic: 'process',
            message: 'Turn it into a plan.',
            visual_direction: 'Show the process flow.',
          },
          {
            beat_id: 'proof',
            title: 'Validation',
            start_sec: 8,
            duration_sec: 4,
            role: 'cta',
            semantic: 'validation',
            message: 'Render and verify.',
            visual_direction: 'Show the output check.',
          },
        ],
      },
      script: {
        hook: 'Intent',
        feature: 'Process',
        cta: 'Render',
      },
      narration: {
        artifact_ref: 'active/shared/exports/narration.aiff',
      },
      design_system: {
        brand_name: 'Kyberion',
      },
    });

    expect(adf.scenes).toHaveLength(3);
    expect(adf.scenes[0].template_ref.template_id).toBe('basic-title-card');
    expect(adf.scenes[1].template_ref.template_id).toBe('howto-guide');
    expect(adf.scenes[2].template_ref.template_id).toBe('logo-outro');
    expect(adf.scenes[1].content.semantic).toBe('process');
    expect(adf.scenes[1].content.body).toBe('Turn it into a plan.');
  });

  it('uses mixed template families for promo storyboards', () => {
    const adf = compileNarratedVideoBriefToCompositionADF({
      kind: 'narrated-video-brief',
      version: '1.0.0',
      language: 'ja',
      storyboard: {
        kind: 'video-storyboard',
        version: '1.0.0',
        content_type: 'promo',
        presentation_mode: 'promo',
        format: { width: 1920, height: 1080 },
        title: 'Promo backed',
        beats: [
          {
            beat_id: 'hook',
            title: 'Hook',
            start_sec: 0,
            duration_sec: 12,
            role: 'hook',
            semantic: 'hook',
            message: 'Lead with value.',
            visual_direction: 'Lead with the hook.',
          },
          {
            beat_id: 'value',
            title: 'Value',
            start_sec: 12,
            duration_sec: 12,
            role: 'feature',
            semantic: 'value',
            message: 'Show the benefit.',
            visual_direction: 'Show the benefit.',
          },
          {
            beat_id: 'proof',
            title: 'Proof',
            start_sec: 24,
            duration_sec: 12,
            role: 'proof',
            semantic: 'proof',
            message: 'Show the evidence.',
            visual_direction: 'Show the evidence.',
          },
          {
            beat_id: 'cta',
            title: 'CTA',
            start_sec: 36,
            duration_sec: 12,
            role: 'cta',
            semantic: 'cta',
            message: 'Ask for action.',
            visual_direction: 'Ask for action.',
          },
        ],
      },
      script: {
        hook: 'Intent',
        feature: 'Value',
        cta: 'Action',
      },
      narration: {
        artifact_ref: 'active/shared/exports/narration.aiff',
      },
      design_system: {
        brand_name: 'Kyberion',
      },
    });

    expect(adf.scenes.map((scene) => scene.template_ref.template_id)).toEqual([
      'basic-title-card',
      'promo-spot',
      'split-highlight',
      'logo-outro',
    ]);
  });

  it('compiles vtuber storyboards into stage-oriented scenes', () => {
    const adf = compileNarratedVideoBriefToCompositionADF({
      kind: 'narrated-video-brief',
      version: '1.0.0',
      language: 'ja',
      storyboard: {
        kind: 'video-storyboard',
        version: '1.0.0',
        content_type: 'vtuber',
        presentation_mode: 'vtuber',
        format: { width: 1280, height: 720, aspect_ratio: '16:9' },
        title: 'Live stage',
        beats: [
          {
            beat_id: 'hook',
            title: 'Hook',
            start_sec: 0,
            duration_sec: 4,
            role: 'hook',
            semantic: 'hook',
            message: 'Open live',
            visual_direction: 'Open live',
          },
          {
            beat_id: 'persona',
            title: 'Persona',
            start_sec: 4,
            duration_sec: 4,
            role: 'feature',
            semantic: 'persona',
            message: 'Introduce persona',
            visual_direction: 'Introduce the persona',
          },
          {
            beat_id: 'demo',
            title: 'Demo',
            start_sec: 8,
            duration_sec: 4,
            role: 'feature',
            semantic: 'demo',
            message: 'Show the demo',
            visual_direction: 'Show the demo',
          },
        ],
      },
      script: {
        hook: 'Intent',
        feature: 'Persona',
        cta: 'Community',
      },
      narration: {
        artifact_ref: 'active/shared/exports/narration.aiff',
      },
      design_system: {
        brand_name: 'Kyberion',
      },
    });

    expect(adf.scenes[0].template_ref.template_id).toBe('vtuber-stage');
    expect(adf.scenes[1].template_ref.template_id).toBe('vtuber-stage');
    expect(adf.scenes[1].content.chat_messages).toBeDefined();
    expect(adf.composition.width).toBe(1280);
    expect(adf.composition.height).toBe(720);
    expect(adf.composition.aspect_ratio).toBe('16:9');
    expect(adf.scenes[0].content.layout_variant).toBe('focus-center');
    expect(adf.scenes[2].content.layout_variant).toBe('fullscreen-demo');
  });
});
