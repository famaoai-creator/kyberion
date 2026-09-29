import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  contrastRatio,
  findDesignStyle,
  listDesignStyles,
  loadDesignFoundation,
  renderFoundationStylesheet,
  resolveComposition,
  validateComposition,
  type CompositionSpec,
} from './design-foundation.js';
import { resolveCreativeDesign } from './creative-design-resolver.js';
import { buildCampaignPlan, type CampaignBrief } from './campaign-suite.js';

const foundation = loadDesignFoundation();

describe('design foundation (KDS v2)', () => {
  it('loads palettes, scales, styles and compositions', () => {
    expect(foundation).not.toBeNull();
    expect(Object.keys(foundation!.palettes).length).toBeGreaterThanOrEqual(8);
    expect(foundation!.palettes.brand['600']).toBe('#2563eb');
    expect(Object.keys(foundation!.styles)).toEqual(
      expect.arrayContaining(['standard', 'editorial', 'midnight-signal', 'graphite-executive'])
    );
    expect(Object.keys(foundation!.compositions).length).toBeGreaterThanOrEqual(8);
  });

  it('keeps every style legible: text 4.5:1, accent 3:1 on its own background, both modes', () => {
    for (const style of listDesignStyles(foundation)) {
      if (!style.colors) continue;
      for (const mode of ['light', 'dark'] as const) {
        const c = style.colors[mode];
        expect(
          contrastRatio(c.text, c.background),
          `${style.id}/${mode} text`
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(c.accent, c.background),
          `${style.id}/${mode} accent`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('style type ramps never drop below the brand hard floors', () => {
    for (const style of listDesignStyles(foundation)) {
      const roles = style.typography?.roles ?? {};
      if (roles.body?.size_pt !== undefined) expect(roles.body.size_pt).toBeGreaterThanOrEqual(10);
      if (roles.label?.size_pt !== undefined) expect(roles.label.size_pt).toBeGreaterThanOrEqual(8);
    }
  });

  it('every catalog composition validates, and preferred_compositions exist', () => {
    for (const [id, spec] of Object.entries(foundation!.compositions)) {
      expect(validateComposition(spec), id).toEqual([]);
    }
    for (const style of listDesignStyles(foundation)) {
      for (const id of style.preferred_compositions) {
        expect(foundation!.compositions[id], `${style.id} → ${id}`).toBeDefined();
      }
    }
  });

  it('resolves a composition to in-bounds rectangles on a 10x5.625in slide', () => {
    const regions = resolveComposition('stat-rail', {
      width: 10,
      height: 5.625,
      margins: [0.3, 0.35, 0.3, 0.35],
      gutter: 0.15,
    });
    expect(regions.map((r) => r.id)).toEqual(['title', 'kpi-1', 'kpi-2', 'kpi-3', 'body']);
    for (const r of regions) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(10.0001);
      expect(r.y + r.h).toBeLessThanOrEqual(5.6251);
    }
    const [k1, k2] = [regions[1], regions[2]];
    expect(k2.x).toBeGreaterThan(k1.x + k1.w); // gutter between tiles
  });

  it('bleed regions extend to the canvas edge', () => {
    const visual = resolveComposition('hero-split', {
      width: 1280,
      height: 720,
      margins: [48, 48, 48, 48],
      gutter: 24,
    }).find((r) => r.id === 'visual')!;
    expect(visual.x + visual.w).toBe(1280);
  });

  it('accepts a custom spec (free layout) and rejects overlaps / overflow', () => {
    const custom: CompositionSpec = {
      rows: 4,
      regions: [
        { id: 'a', role: 'title', col: [1, 12], row: [1, 1] },
        { id: 'b', role: 'body', col: [1, 8], row: [2, 3] },
        { id: 'c', role: 'visual', col: [9, 4], row: [2, 3] },
      ],
    };
    expect(validateComposition(custom)).toEqual([]);
    expect(resolveComposition(custom, { width: 1200, height: 800 })).toHaveLength(3);

    const bad: CompositionSpec = {
      rows: 2,
      regions: [
        { id: 'a', role: 'title', col: [1, 8], row: [1, 1] },
        { id: 'b', role: 'body', col: [6, 8], row: [1, 1] },
        { id: 'c', role: 'card', col: [1, 12], row: [2, 2] },
      ],
    };
    const messages = validateComposition(bad)
      .map((i) => i.message)
      .join('|');
    expect(messages).toMatch(/overlaps "a"/);
    expect(messages).toMatch(/spills past column 12/);
    expect(messages).toMatch(/spills past row 2/);
    expect(() => resolveComposition(bad, { width: 100, height: 100 })).toThrow(
      /Invalid composition/
    );
  });

  it('kyberion-ds.css is in sync with the foundation JSON', () => {
    const cssPath = path.join(
      pathResolver.rootDir(),
      'knowledge/public/design-patterns/web/kyberion-ds.css'
    );
    expect(String(safeReadFile(cssPath, { encoding: 'utf8' }))).toBe(
      renderFoundationStylesheet(foundation!)
    );
  });
});

describe('resolveCreativeDesign({ style })', () => {
  it('is a no-op for no style, "standard" and unknown ids', () => {
    const base = resolveCreativeDesign({ surface: 'pptx' });
    for (const style of [undefined, 'standard', 'does-not-exist']) {
      const resolved = resolveCreativeDesign({ surface: 'pptx', style });
      expect(resolved.colors).toEqual(base.colors);
      expect(resolved.typography).toEqual(base.typography);
      expect(resolved.design_style).toBeUndefined();
      expect(resolved.foundation_css_vars).toBeUndefined();
    }
    expect(findDesignStyle('standard', foundation)).toBeUndefined();
  });

  it('restyles palette, heading face and type ramp for a fixed scenario', () => {
    const base = resolveCreativeDesign({ surface: 'pptx' });
    const editorial = resolveCreativeDesign({ surface: 'pptx', style: 'editorial' });
    expect(editorial.colors.accent).toBe('#c2410c');
    expect(editorial.colors.accent).not.toBe(base.colors.accent);
    expect(editorial.fonts.heading).toMatch(/Serif|Mincho|Georgia/);
    expect(editorial.typography.roles.display.size_pt).toBe(40);
    // roles the style does not name keep their brand values
    expect(editorial.typography.roles.caption).toEqual(base.typography.roles.caption);
    expect(editorial.design_style?.id).toBe('editorial');
    expect(editorial.foundation_css_vars?.['--kds-style-accent']).toBe('#c2410c');
    expect(editorial.foundation_css_vars?.['--kds-color-brand-600']).toBe('#2563eb');
    if (editorial.projection.surface === 'pptx') {
      expect(editorial.projection.theme.fonts.heading).toBe(editorial.fonts.heading);
    }
  });

  it('follows the requested mode and reaches video css vars', () => {
    const dark = resolveCreativeDesign({ surface: 'video', style: 'midnight-signal' });
    expect(dark.mode).toBe('dark');
    expect(dark.colors.accent).toBe('#22d3ee');
    if (dark.projection.surface === 'video') {
      expect(dark.projection.css_vars['--kds-style-radius']).toBe('12px');
      // brand mode vars still win where both define a key
      expect(dark.projection.css_vars['--kb-accent']).toBe('#22d3ee');
    }
  });
});

describe('one style across every creative output (campaign suite + prompts)', () => {
  const campaign = (design_style?: string): CampaignBrief => ({
    kind: 'campaign-brief',
    title: '新製品ローンチ',
    audience: '経営層',
    ...(design_style ? { design_style } : {}),
    deliverables: ['deck', 'doc', 'intro_video', 'web_lp'],
    key_messages: ['承認を速くする', '証跡を自動で残す'],
  });

  it('every deliverable resolves the same styled accent', () => {
    const plan = buildCampaignPlan(campaign('editorial'), { outputRoot: 'out' });
    expect(plan.entries.map((entry) => entry.design.accent_hex)).toEqual(
      plan.entries.map(() => '#c2410c')
    );
    expect(plan.manifest.design_style).toBe('editorial');
  });

  it('passes the style to the media briefs and into the video/web design', () => {
    const plan = buildCampaignPlan(campaign('editorial'), { outputRoot: 'out' });
    const deck = plan.entries.find((entry) => entry.kind === 'deck')!;
    const context = (deck.action_input as any).context.last_json;
    expect(context.design_style).toBe('editorial');
    const video = plan.entries.find((entry) => entry.kind === 'intro_video')!;
    const cssVars = (video.action_input as any).params.content_brief.design_system_ref.css_vars;
    expect(cssVars['--kds-style-radius']).toBe('2px');
    const web = plan.entries.find((entry) => entry.kind === 'web_lp')!;
    const html = (web.action_input as any).context.lp_html as string;
    expect(html).toContain('--kds-style-radius');
    expect(html).toContain('var(--kds-style-radius, 14px)');
  });

  it('a campaign without a style keeps the baseline (no design_style anywhere)', () => {
    const plan = buildCampaignPlan(campaign(), { outputRoot: 'out' });
    const deck = plan.entries.find((entry) => entry.kind === 'deck')!;
    expect((deck.action_input as any).context.last_json.design_style).toBeUndefined();
    expect(plan.manifest.design_style).toBeUndefined();
  });

  it('the prompt style pack carries the style tone words, palette and anti-patterns', () => {
    const resolved = resolveCreativeDesign({ surface: 'prompt', style: 'midnight-signal' });
    if (resolved.projection.surface !== 'prompt') throw new Error('expected prompt projection');
    const pack = resolved.projection.style_pack;
    expect(pack.tone_words).toContain('single cyan accent');
    expect(pack.avoid).toContain('rainbow palettes');
    expect(pack.palette_hex).toContain('#22d3ee');
    const base = resolveCreativeDesign({ surface: 'prompt' });
    if (base.projection.surface !== 'prompt') throw new Error('expected prompt projection');
    expect(base.projection.style_pack.tone_words).not.toContain('single cyan accent');
  });
});
