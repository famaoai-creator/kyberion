/**
 * MP-02: the lint that has to fail a bundle rather than let it render.
 *
 * Determinism findings are errors because a render that reads a clock or rolls
 * a die is not reproducible, which makes every downstream regression test
 * meaningless. Tiling gaps are errors because they show as blank frames.
 */
import { describe, expect, it } from 'vitest';
import { formatVideoLintReport, lintVideoComposition } from './video-composition-lint.js';
import { normalizeVideoMotionDirection } from './video-motion-direction.js';
import type { VideoCompositionADF } from './video-composition-contract.js';

function adf(overrides: Partial<VideoCompositionADF> = {}): VideoCompositionADF {
  const base: VideoCompositionADF = {
    kind: 'video-composition-adf',
    version: '1.0.0',
    composition: { duration_sec: 8, fps: 30, width: 1920, height: 1080 },
    scenes: [
      {
        scene_id: 'hook',
        role: 'hook',
        start_sec: 0,
        duration_sec: 3,
        template_ref: { template_id: 'basic-title-card' },
        content: {},
      },
      {
        scene_id: 'proof',
        role: 'proof',
        start_sec: 3,
        duration_sec: 5,
        template_ref: { template_id: 'split-highlight' },
        content: {},
      },
    ],
    output: { format: 'mp4' },
  };
  return { ...base, ...overrides };
}

function rules(report: ReturnType<typeof lintVideoComposition>): string[] {
  return report.findings.map((finding) => finding.rule);
}

describe('scene window tiling', () => {
  it('passes a composition whose scenes tile end-to-end', () => {
    const report = lintVideoComposition({ adf: adf() });
    expect(report.ok).toBe(true);
    expect(report.error_count).toBe(0);
  });

  it('flags a gap between scenes as an error', () => {
    const composition = adf();
    composition.scenes[1].start_sec = 4;
    composition.scenes[1].duration_sec = 4;
    const report = lintVideoComposition({ adf: composition });
    expect(report.ok).toBe(false);
    expect(rules(report)).toContain('scenes/no-gap');
  });

  it('flags overlapping scenes as an error', () => {
    const composition = adf();
    composition.scenes[1].start_sec = 2;
    const report = lintVideoComposition({ adf: composition });
    expect(rules(report)).toContain('scenes/no-overlap');
  });

  it('flags scenes running past the composition duration', () => {
    const composition = adf();
    composition.composition.duration_sec = 5;
    const report = lintVideoComposition({ adf: composition });
    expect(rules(report)).toContain('scenes/within-duration');
    expect(report.ok).toBe(false);
  });

  it('warns when scenes leave a blank tail', () => {
    const composition = adf();
    composition.composition.duration_sec = 12;
    const report = lintVideoComposition({ adf: composition });
    expect(rules(report)).toContain('scenes/fills-duration');
    // A blank tail is a quality problem, not a broken render.
    expect(report.ok).toBe(true);
  });

  it('errors on an empty composition', () => {
    const report = lintVideoComposition({ adf: adf({ scenes: [] }) });
    expect(rules(report)).toContain('scenes/non-empty');
  });
});

describe('determinism rules', () => {
  const banned = [
    ['Math.random', '<script>const x = Math.random();</script>'],
    ['Date.now', '<script>const t = Date.now();</script>'],
    ['setTimeout', '<script>setTimeout(() => {}, 10);</script>'],
    ['requestAnimationFrame', '<script>requestAnimationFrame(tick);</script>'],
    ['repeat -1', '<script>gsap.to(el, { repeat: -1 });</script>'],
  ] as const;

  for (const [label, html] of banned) {
    it(`rejects ${label} in scene HTML`, () => {
      const report = lintVideoComposition({ adf: adf(), sceneHtml: { hook: html } });
      expect(report.ok).toBe(false);
      expect(rules(report)).toContain('determinism/no-clock-or-random');
    });
  }

  it('accepts deterministic scene HTML', () => {
    const report = lintVideoComposition({
      adf: adf(),
      sceneHtml: { hook: '<style>.a { animation: kb-in-fade-rise 0.8s ease both; }</style>' },
    });
    expect(report.ok).toBe(true);
  });
});

describe('motion layering', () => {
  it('errors when a scene has fewer than two mid-scene layers', () => {
    const composition = adf();
    composition.composition.motion_direction = {
      scenes: [
        {
          scene_id: 'hook',
          entrance: { pattern_id: 'pop-in', ease: 'overshoot', duration_sec: 0.6, offset_sec: 0.1 },
          midscene: [{ pattern_id: 'breathe', ease: 'sine-io', duration_sec: 4 }],
        },
      ],
      transitions: [],
    };
    const report = lintVideoComposition({ adf: composition });
    expect(rules(report)).toContain('motion/no-static-slides');
    expect(report.ok).toBe(false);
  });

  it('passes a normalized direction, which meets the floor by construction', () => {
    const composition = adf();
    composition.composition.motion_direction = normalizeVideoMotionDirection(
      null,
      composition.scenes.map((scene) => ({
        scene_id: scene.scene_id,
        role: scene.role,
        duration_sec: scene.duration_sec,
      }))
    );
    const report = lintVideoComposition({ adf: composition });
    expect(report.ok).toBe(true);
    expect(rules(report)).not.toContain('motion/no-static-slides');
  });
});

describe('scene compositions', () => {
  function withCompositions(compositions: any[]) {
    const composition = adf();
    composition.composition.scene_compositions = compositions;
    return composition;
  }

  it('accepts a well-formed set', () => {
    const report = lintVideoComposition({
      adf: withCompositions([
        {
          scene_id: 'hook',
          layout: 'stack',
          blocks: [
            { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
          ],
        },
        {
          scene_id: 'proof',
          layout: 'split-left',
          blocks: [
            { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
          ],
        },
      ]),
    });
    expect(rules(report)).not.toContain('composition/single-focal-point');
    expect(report.ok).toBe(true);
  });

  it('flags a scene with no single focal point', () => {
    const report = lintVideoComposition({
      adf: withCompositions([
        {
          scene_id: 'hook',
          layout: 'stack',
          blocks: [
            { type: 'headline', content_key: 'headline', emphasis: 'support', column: 'primary' },
            { type: 'body', content_key: 'body', emphasis: 'support', column: 'primary' },
          ],
        },
      ]),
    });
    expect(rules(report)).toContain('composition/single-focal-point');
  });

  it('flags a composition targeting a scene that does not exist', () => {
    const report = lintVideoComposition({
      adf: withCompositions([
        {
          scene_id: 'ghost',
          layout: 'stack',
          blocks: [
            { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
          ],
        },
      ]),
    });
    expect(rules(report)).toContain('composition/unknown-scene');
  });

  it('flags a video where every scene uses the same layout', () => {
    const composition = adf();
    composition.scenes.push({
      scene_id: 'cta',
      role: 'cta',
      start_sec: 8,
      duration_sec: 2,
      template_ref: { template_id: 'logo-outro' },
      content: {},
    });
    composition.composition.duration_sec = 10;
    composition.composition.scene_compositions = ['hook', 'proof', 'cta'].map((sceneId) => ({
      scene_id: sceneId,
      layout: 'stack',
      blocks: [{ type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' }],
    })) as any;

    const report = lintVideoComposition({ adf: composition });
    expect(rules(report)).toContain('composition/layout-variety');
    // Monotony is a quality finding, not a broken render.
    expect(report.ok).toBe(true);
  });
});

describe('typography floor', () => {
  it('warns on literal font sizes below the video legibility floor', () => {
    const report = lintVideoComposition({
      adf: adf(),
      sceneHtml: { hook: '<style>.caption { font-size: 12px; }</style>' },
    });
    expect(rules(report)).toContain('typography/min-size');
    // Illegible text is a quality finding, not a broken render.
    expect(report.ok).toBe(true);
  });

  it('ignores token-driven sizes', () => {
    const report = lintVideoComposition({
      adf: adf(),
      sceneHtml: { hook: '<style>.caption { font-size: var(--kb-size-body); }</style>' },
    });
    expect(rules(report)).not.toContain('typography/min-size');
  });
});

describe('formatVideoLintReport', () => {
  it('reports a clean bundle', () => {
    expect(formatVideoLintReport(lintVideoComposition({ adf: adf() }))).toContain('no findings');
  });

  it('lists errors before warnings', () => {
    const composition = adf();
    composition.composition.duration_sec = 12;
    const report = lintVideoComposition({
      adf: composition,
      sceneHtml: { hook: '<script>const t = Date.now();</script>' },
    });
    const lines = formatVideoLintReport(report).split('\n');
    expect(lines[0]).toContain('[error]');
    expect(lines[lines.length - 1]).toContain('[warning]');
  });
});
