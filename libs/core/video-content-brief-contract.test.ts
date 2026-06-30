import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { compileVideoContentBriefToStoryboard, compileVideoStoryboardToNarratedVideoBrief } from './video-content-brief-contract.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('video content brief contract', () => {
  it('compiles a how-to brief into a storyboard and narrated brief', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      title: 'Kyberion how-to',
      audience: 'operators',
      objective: 'turn a brief into a video',
      distribution_channel: 'docs-demo',
      content_type: 'howto',
      presentation_mode: 'howto',
      promise: 'clear governed output',
      desired_takeaway: 'content brief becomes renderable',
      constraints: ['no pitch'],
      proof_points: ['brief', 'storyboard', 'render'],
      content_requirements: ['show intake', 'show plan', 'show render'],
      fixed_inputs: {
        customer: 'operators',
        use_case: 'governed work',
        message: 'brief to video',
      },
      tone: 'practical',
      language: 'ja',
      duration_sec: 12,
      format: {
        width: 1280,
        height: 720,
      },
      design_system_ref: {
        system_id: 'operator-ops',
        brand_name: 'Kyberion',
        background_color: '#07111f',
        hero_path: 'active/shared/assets/hero.png',
        logo_path: 'active/shared/assets/logo.png',
        fps: 30,
      },
    });

    expect(storyboard.kind).toBe('video-storyboard');
    expect(storyboard.format.aspect_ratio).toBe('1280:720');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[1].semantic).toBe('process');
    expect(storyboard.beats[1].design_token_hints?.typography_scale).toBe('balanced');
    expect(storyboard.beats[0].layout_variant).toBe('split-left');

    const narrated = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
      narration_artifact_ref: 'active/shared/exports/narration.aiff',
      output: {
        format: 'mp4',
      },
    });

    expect(narrated.kind).toBe('narrated-video-brief');
    expect(narrated.storyboard?.kind).toBe('video-storyboard');
    expect(narrated.script.hook).toContain('clear governed output');
    expect(narrated.script.cta).toContain('content brief');
  });

  it('compiles promo briefs into promo-oriented beats and layout defaults', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'prospective customers',
      objective: 'promote a product launch',
      distribution_channel: 'youtube',
      content_type: 'product-launch',
      presentation_mode: 'promo',
      promise: 'launch value in the first beat',
      desired_takeaway: 'click to learn more',
      constraints: ['no generic pitch'],
      proof_points: ['launch date', 'customer proof'],
      design_system_ref: {
        system_id: 'promo-kit',
        brand_name: 'Kyberion',
      },
    });

    expect(storyboard.presentation_mode).toBe('promo');
    expect(storyboard.design_system_ref?.layout_family).toBe('promo-spot');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[1].semantic).toBe('value');
    expect(storyboard.beats[0].design_token_hints?.typography_scale).toBe('expressive');
  });

  it('compiles vtuber briefs into stage-oriented beats with live presentation hints', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'live viewers',
      objective: 'present an on-air persona and demo',
      distribution_channel: 'live-stream',
      content_type: 'vtuber',
      presentation_mode: 'vtuber',
      promise: 'live persona with governed workflow',
      desired_takeaway: 'the viewer sees the persona, demo, and CTA',
      constraints: ['keep it live'],
      proof_points: ['persona', 'demo', 'cta'],
      design_system_ref: {
        system_id: 'vtuber-kit',
        brand_name: 'Kyberion',
      },
    });

    expect(storyboard.presentation_mode).toBe('vtuber');
    expect(storyboard.design_system_ref?.layout_family).toBe('vtuber-stage');
    expect(storyboard.design_system_ref?.css_vars?.['--kb-bg-main']).toBe('#090814');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[0].design_token_hints?.camera_distance).toBe('medium-close');
    expect(storyboard.beats[2].design_token_hints?.overlay_density).toBe('dense');
    expect(storyboard.beats[0].layout_variant).toBe('focus-center');
    expect(storyboard.beats[2].layout_variant).toBe('fullscreen-demo');
  });

  it('keeps schema contracts aligned with design-system video fields', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    const contentBriefSchema = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/product/schemas/video-content-brief.schema.json'));
    const storyboardSchema = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/product/schemas/video-storyboard.schema.json'));
    const narratedBriefSchema = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/product/schemas/narrated-video-brief.schema.json'));

    const contentBrief = {
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'operators',
      objective: 'present an on-air persona and demo',
      distribution_channel: 'live-stream',
      content_type: 'vtuber',
      presentation_mode: 'vtuber',
      promise: 'live persona with governed workflow',
      desired_takeaway: 'the viewer sees the persona, demo, and CTA',
      constraints: ['keep it live'],
      proof_points: ['persona', 'demo', 'cta'],
      format: {
        width: 1080,
        height: 1920,
        aspect_ratio: '9:16',
      },
      design_system_ref: {
        system_id: 'vtuber-kit',
        brand_name: 'Kyberion',
        css_vars: {
          '--kb-bg-main': '#101827',
          '--kb-panel-radius': '28px',
        },
      },
    };

    expect(contentBriefSchema(contentBrief)).toBe(true);

    const storyboard = compileVideoContentBriefToStoryboard(contentBrief as any);
    expect(storyboardSchema(storyboard)).toBe(true);

    const narrated = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
      narration_artifact_ref: 'active/shared/exports/narration.aiff',
      output: { format: 'mp4' },
    });
    expect(narratedBriefSchema(narrated)).toBe(true);
  });
});
