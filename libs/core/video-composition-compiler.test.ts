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
    expect(plan.narration_ref).toBeUndefined();

    const written = writeVideoCompositionBundle(adf);
    expect(written.bundle_dir).toBe(bundleDir);
    expect(safeExistsSync(`${bundleDir}/index.html`)).toBe(true);
    expect(safeExistsSync(`${bundleDir}/render-plan.json`)).toBe(true);
    expect(safeReadFile(`${bundleDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain('Explain the product clearly');
  });

  it('carries narration references into the render plan', () => {
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Narrated explainer',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      audio: {
        narration_ref: 'active/shared/tmp/narration.aiff',
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'basic-title-card' },
          content: { headline: 'Narrated' },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: pathResolver.sharedTmp('video-composition-bundle-tests/narrated-explainer'),
      },
    };

    const plan = compileVideoCompositionADF(adf);
    expect(plan.narration_ref).toBe(pathResolver.resolve('active/shared/tmp/narration.aiff'));
    expect(plan.artifact_refs).toContain(pathResolver.resolve('active/shared/tmp/narration.aiff'));
  });

  it('carries music references into the render plan', () => {
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Music video',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      audio: {
        music_ref: 'active/shared/tmp/music-track.mp3',
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'basic-title-card' },
          content: { headline: 'Music driven cut' },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: pathResolver.sharedTmp('video-composition-bundle-tests/music-video'),
      },
    };

    const plan = compileVideoCompositionADF(adf);
    expect(plan.music_ref).toBe(pathResolver.resolve('active/shared/tmp/music-track.mp3'));
    expect(plan.artifact_refs).toContain(pathResolver.resolve('active/shared/tmp/music-track.mp3'));
  });

  it('renders a process-oriented fallback visual when no supporting asset is provided', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/process-visual');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Process visual',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      scenes: [
        {
          scene_id: 'feature',
          role: 'feature',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'split-highlight' },
          content: {
            headline: 'From brief to scene plan',
            body: 'Turn a fixed brief into a renderable content outline.',
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: bundleDir,
      },
    };

    writeVideoCompositionBundle(adf);
    const html = safeReadFile(`${bundleDir}/compositions/feature.html`, { encoding: 'utf8' }) as string;
    expect(html).toContain('Brief intake');
    expect(html).toContain('Render package');
  });

  it('renders howto guide templates with step chips and fallback stage text', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/howto-guide');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Howto guide',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      scenes: [
        {
          scene_id: 'process',
          role: 'feature',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'howto-guide' },
          content: {
            headline: 'Turn the brief into a storyboard',
            body: 'Convert the approved brief into a governed outline.',
            visual_steps: [
              { step: '01', detail: 'Brief intake' },
              { step: '02', detail: 'Content plan' },
              { step: '03', detail: 'Render package' },
            ],
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: bundleDir,
      },
    };

    writeVideoCompositionBundle(adf);
    const html = safeReadFile(`${bundleDir}/compositions/process.html`, { encoding: 'utf8' }) as string;
    expect(html).toContain('Ordered steps');
    expect(html).toContain('Brief intake');
    expect(html).toContain('Render package');
  });

  it('renders promo and vtuber templates with mode-specific layouts', () => {
    const promoDir = pathResolver.sharedTmp('video-composition-bundle-tests/promo-spot');
    const vtuberDir = pathResolver.sharedTmp('video-composition-bundle-tests/vtuber-stage');

    writeVideoCompositionBundle({
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Promo spot',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#08101e',
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'promo-spot' },
          content: {
            headline: 'Launch value',
            body: 'Show the promise with proof.',
            presentation_mode: 'promo',
            value_points: ['Value spike', 'Proof point'],
            social_proof: ['Customer proof'],
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: promoDir,
      },
    });

    writeVideoCompositionBundle({
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'VTuber stage',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#090814',
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'vtuber-stage' },
          content: {
            headline: 'Live on air',
            body: 'Start with the avatar and the premise.',
            presentation_mode: 'vtuber',
            chat_messages: [
              { speaker: 'chat', text: 'What are we building today?' },
              { speaker: 'kyberion', text: 'A governed pipeline.' },
            ],
            stage_notes: ['On air', 'Guided step'],
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: vtuberDir,
      },
    });

    expect(safeReadFile(`${promoDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain('Promo spot');
    expect(safeReadFile(`${vtuberDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain('LIVE');
  });
});
