import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';
import {
  compileVideoCompositionADF,
  writeVideoCompositionBundle,
} from './video-composition-compiler.js';
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
    expect(safeReadFile(`${bundleDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain(
      'Explain the product clearly'
    );
  });

  it('threads tenant design_system_vars into rendered scene css (DS-04 / E2E-02)', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/tenant-branding');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      intent: 'Tenant branded',
      title: 'Tenant branded',
      composition: {
        duration_sec: 3,
        fps: 24,
        width: 1280,
        height: 720,
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
            headline: 'Branded hook',
            design_system_vars: {
              '--kb-accent': '#ff00aa',
              '--kb-accent-blue': '#ff00aa',
              '--kb-bg-main': '#101010',
            },
          },
        },
      ],
      output: { format: 'mp4', bundle_dir: bundleDir },
    };

    writeVideoCompositionBundle(adf);
    const html = safeReadFile(`${bundleDir}/compositions/hook.html`, {
      encoding: 'utf8',
    }) as string;

    // Tenant overrides land on :root, and tokenized scene styles resolve to them.
    expect(html).toContain('--kb-accent: #ff00aa');
    expect(html).toContain('--kb-bg-main: #101010');
    expect(html).toContain('var(--kb-accent-blue');
  });

  it('slugifies the composition id from the intent when present', () => {
    const plan = compileVideoCompositionADF({
      kind: 'video-composition-adf',
      version: '1.0.0',
      intent: 'Product Explainer',
      title: 'Product Explainer',
      composition: {
        duration_sec: 4,
        fps: 24,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      scenes: [],
      output: {
        format: 'mp4',
        bundle_dir: pathResolver.sharedTmp('video-composition-bundle-tests/slugified-id'),
      },
    });

    expect(plan.composition_id).toBe('product-explainer');
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

  it('omits placeholder process steps when no visual_steps are provided', () => {
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
    const html = safeReadFile(`${bundleDir}/compositions/feature.html`, {
      encoding: 'utf8',
    }) as string;
    // agy short-video quality: missing visual_steps must no longer inject
    // English demo placeholders ("Brief intake" etc.) into real videos.
    expect(html).not.toContain('Brief intake');
    expect(html).not.toContain('Render package');
    expect(html).toContain('process-visual');
    expect(html).toContain('var(--kb-accent-blue-soft, #93c5fd)');
    expect(html).toContain('var(--kb-bg-main, #081225)');
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
    const html = safeReadFile(`${bundleDir}/compositions/process.html`, {
      encoding: 'utf8',
    }) as string;
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

    expect(safeReadFile(`${promoDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain(
      'Promo spot'
    );
    expect(safeReadFile(`${vtuberDir}/compositions/hook.html`, { encoding: 'utf8' })).toContain(
      'LIVE'
    );
  });

  it('sanitizes unsafe scene ids before writing bundle artifacts and runtime keys', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/scene-id-safety');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Scene id safety',
      composition: {
        duration_sec: 4,
        fps: 30,
        width: 1280,
        height: 720,
        background_color: '#081225',
      },
      scenes: [
        {
          scene_id: 'foo/../bar<script>',
          role: 'hook',
          start_sec: 0,
          duration_sec: 4,
          template_ref: { template_id: 'basic-title-card' },
          content: {
            headline: 'Safe scene keys',
            body: 'Scene ids are normalized before they hit the filesystem.',
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: bundleDir,
      },
    };

    writeVideoCompositionBundle(adf);
    expect(safeExistsSync(`${bundleDir}/compositions/foo-bar-script.html`)).toBe(true);
    const html = safeReadFile(`${bundleDir}/compositions/foo-bar-script.html`, {
      encoding: 'utf8',
    }) as string;
    expect(html).toContain('window.__timelines["foo-bar-script"]');
    expect(html).not.toContain('foo/../bar<script>');
  });

  it('stages avatar_assets declared in scene content for vtuber rendering', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/avatar-assets');
    const avatarPath = pathResolver.sharedTmp(
      'video-composition-bundle-tests/assets/avatar-smile.png'
    );
    safeWriteFile(avatarPath, 'avatar-bytes');

    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Avatar assets',
      composition: {
        duration_sec: 4,
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
          duration_sec: 4,
          template_ref: { template_id: 'vtuber-stage' },
          content: {
            headline: 'Live avatar',
            body: 'Use the scene-specific avatar asset.',
            presentation_mode: 'vtuber',
            layout_variant: 'focus-center',
            avatar_assets: {
              default: avatarPath,
            },
          },
        },
      ],
      output: {
        format: 'mp4',
        bundle_dir: bundleDir,
      },
    };

    writeVideoCompositionBundle(adf);
    const html = safeReadFile(`${bundleDir}/compositions/hook.html`, {
      encoding: 'utf8',
    }) as string;
    expect(html).toContain('../assets/avatar-smile.png');
    expect(safeExistsSync(`${bundleDir}/assets/avatar-smile.png`)).toBe(true);
  });

  it('renders the quote-card template and honors visual-direction scene layouts', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/quote-card');
    const adf: any = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      title: 'Quote Demo',
      composition: {
        duration_sec: 6,
        fps: 30,
        width: 1080,
        height: 1920,
        visual_direction: {
          mood: 'mono-editorial',
          palette: {
            bg: '#fafafa',
            panel: '#f0f0f0',
            accent: '#dc2626',
            accent_text: '#7f1d1d',
            text: '#0a0a0a',
            subtext: '#525252',
          },
          typography: { headline_px: 104, body_px: 36 },
          per_scene: [
            { scene_id: 'hook', layout_variant: 'quote-card' },
            { scene_id: 'detail', layout_variant: 'split-highlight' },
          ],
        },
      },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 3,
          content: { headline: '意図こそがインターフェースだ', eyebrow: 'Kyberion' },
        },
        {
          scene_id: 'detail',
          role: 'generic',
          start_sec: 3,
          duration_sec: 3,
          // body is missing -> split-highlight is NOT satisfiable, so the
          // directed layout must be skipped and the default kept.
          content: { headline: 'Detail scene' },
        },
      ],
      output: { format: 'mp4', bundle_dir: bundleDir },
    };

    writeVideoCompositionBundle(adf);
    const hook = safeReadFile(`${bundleDir}/compositions/hook.html`, {
      encoding: 'utf8',
    }) as string;
    expect(hook).toContain('quote-text');
    expect(hook).toContain('意図こそがインターフェースだ');
    expect(hook).toContain('--headline-size: 104px;');
    const detail = safeReadFile(`${bundleDir}/compositions/detail.html`, {
      encoding: 'utf8',
    }) as string;
    expect(detail).not.toContain('split-card');
  });
});
