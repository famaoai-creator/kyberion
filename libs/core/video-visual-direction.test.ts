import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISUAL_DIRECTION,
  generateVideoVisualDirection,
  normalizeVideoVisualDirection,
  visualDirectionToCssVars,
} from './video-visual-direction.js';

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

const VALID = {
  mood: 'warm-documentary',
  palette: {
    bg: '#1a120b',
    panel: '#241a10',
    accent: '#f59e0b',
    accent_text: '#fde68a',
    text: '#fef3c7',
    subtext: '#d6bfa3',
  },
  typography: { headline_px: 100, body_px: 36 },
  per_scene: [{ scene_id: 'hook', layout_variant: 'quote-card' }],
};

describe('video visual direction (agy short-video quality)', () => {
  it('accepts a valid LLM draft and keeps its palette', () => {
    const direction = normalizeVideoVisualDirection(VALID, PORTRAIT);
    expect(direction.palette.accent).toBe('#f59e0b');
    expect(direction.mood).toBe('warm-documentary');
    expect(direction.per_scene?.[0].layout_variant).toBe('quote-card');
  });

  it('clamps typography into the portrait-legible range', () => {
    const direction = normalizeVideoVisualDirection(
      { ...VALID, typography: { headline_px: 20, body_px: 500 } },
      PORTRAIT
    );
    expect(direction.typography.headline_px).toBe(72);
    expect(direction.typography.body_px).toBe(48);
  });

  it('rejects malformed colors wholesale (no partial palettes)', () => {
    const direction = normalizeVideoVisualDirection(
      { ...VALID, palette: { ...VALID.palette, bg: 'darkish' } },
      PORTRAIT
    );
    expect(direction.palette).toEqual(DEFAULT_VISUAL_DIRECTION.palette);
    expect(direction.typography.headline_px).toBe(96);
  });

  it('gives portrait frames a larger default type scale than landscape', () => {
    expect(normalizeVideoVisualDirection(null, PORTRAIT).typography.headline_px).toBe(96);
    expect(normalizeVideoVisualDirection(null, LANDSCAPE).typography.headline_px).toBe(68);
  });

  it('emits css vars on the compiler token names', () => {
    const css = visualDirectionToCssVars(normalizeVideoVisualDirection(VALID, PORTRAIT));
    expect(css).toContain('--kb-bg-main: #1a120b;');
    expect(css).toContain('--kb-accent-blue: #f59e0b;');
    expect(css).toContain('--headline-size: 100px;');
  });

  it('generateVideoVisualDirection parses injected model output and degrades on garbage', async () => {
    const good = await generateVideoVisualDirection({
      title: 'T',
      story: 'S',
      frame: PORTRAIT,
      generate: async () => `Here you go:\n${JSON.stringify(VALID)}`,
    });
    expect(good.palette.bg).toBe('#1a120b');

    const bad = await generateVideoVisualDirection({
      title: 'T',
      story: 'S',
      frame: PORTRAIT,
      generate: async () => 'no json at all',
    });
    expect(bad.palette).toEqual(DEFAULT_VISUAL_DIRECTION.palette);

    const thrown = await generateVideoVisualDirection({
      title: 'T',
      story: 'S',
      frame: PORTRAIT,
      generate: async () => {
        throw new Error('backend down');
      },
    });
    expect(thrown.palette).toEqual(DEFAULT_VISUAL_DIRECTION.palette);
  });
});
