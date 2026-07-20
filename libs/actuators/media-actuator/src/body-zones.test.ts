/**
 * Body-zone vocabulary.
 *
 * Layout expressiveness was capped by construction: six zones existed and
 * every unmapped semantic type fell through to single_column, so a deck with
 * eight distinct meanings rendered as three visual shapes. Zones declared with
 * `regions` are now built from JSON alone, so these assert the contract that
 * makes adding one safe — geometry stays on the slide, text still gets fitted,
 * and distinct semantics reach distinct zones.
 */
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { handleAction } from './index.js';

const CANVAS = { w: 10, h: 5.625 };

function loadZoneCatalog(): Record<string, any> {
  const raw = safeReadFile(
    pathResolver.knowledge(
      'public/design-patterns/media-templates/slide-layout-presets/body-zone-layouts.json'
    ),
    { encoding: 'utf8' }
  ) as string;
  return JSON.parse(raw).body_zones;
}

async function compileWithSemantic(semanticType: string, body: string[]): Promise<any> {
  const result = await handleAction({
    action: 'pipeline',
    context: {
      last_json: {
        kind: 'proposal-brief',
        document_profile: 'executive-proposal',
        render_target: 'pptx',
        locale: 'ja-JP',
        title: 'ゾーン検証',
        objective: 'ゾーンごとの描画を検証する。',
        story: { core_message: '検証用の本文です。', closing_cta: '確認をお願いします。' },
        sections: [{ title: '検証', objective: '検証用', body, semantic_type: semanticType }],
      },
    },
    steps: [
      {
        type: 'transform',
        op: 'brief_to_design_protocol',
        params: { from: 'last_json', export_as: 'pptx_design' },
      },
    ],
  } as any);
  expect(result.status).toBe('succeeded');
  return result.context.pptx_design;
}

describe('zone catalog', () => {
  const catalog = loadZoneCatalog();
  const regionZones = Object.entries(catalog).filter(
    ([key, zone]: [string, any]) => !key.startsWith('_') && Array.isArray(zone?.regions)
  );

  it('ships region-declarative zones beyond the original six', () => {
    expect(regionZones.length).toBeGreaterThanOrEqual(6);
  });

  for (const [zoneKey, zone] of regionZones) {
    describe(zoneKey, () => {
      it('declares a usable region for every entry', () => {
        for (const region of zone.regions) {
          expect(region.id, `${zoneKey} region missing id`).toBeTruthy();
          expect(['text', 'panel']).toContain(region.type);
          expect(region.source, `${zoneKey}.${region.id} missing source`).toBeTruthy();
          expect(region.pos, `${zoneKey}.${region.id} missing pos`).toBeDefined();
        }
      });

      it('keeps every region inside the slide canvas', () => {
        // Anchors match the chrome the renderer resolves against.
        const anchors: Record<string, number> = {
          body_x: 0.44,
          body_y: 0.76,
          body_w: 9.15,
          body_h: 4.55,
        };
        const coord = (pos: any, key: string): number => {
          const raw = pos[key];
          const base = typeof raw === 'number' ? raw : (anchors[raw] ?? 0);
          return base + Number(pos[`${key}_offset`] ?? 0);
        };
        for (const region of zone.regions) {
          const x = coord(region.pos, 'x');
          const y = coord(region.pos, 'y');
          const w = coord(region.pos, 'w');
          const h = coord(region.pos, 'h');
          expect(w, `${zoneKey}.${region.id} width`).toBeGreaterThan(0);
          expect(h, `${zoneKey}.${region.id} height`).toBeGreaterThan(0);
          expect(x, `${zoneKey}.${region.id} left edge`).toBeGreaterThanOrEqual(0);
          expect(y, `${zoneKey}.${region.id} top edge`).toBeGreaterThanOrEqual(0);
          expect(x + w, `${zoneKey}.${region.id} right edge`).toBeLessThanOrEqual(CANVAS.w + 0.01);
          expect(y + h, `${zoneKey}.${region.id} bottom edge`).toBeLessThanOrEqual(CANVAS.h + 0.01);
        }
      });

      it('respects the type ramp floor on every region', () => {
        for (const region of zone.regions) {
          if (region.font_size === undefined) continue;
          expect(region.font_size, `${zoneKey}.${region.id} font size`).toBeGreaterThanOrEqual(10);
        }
      });
    });
  }
});

describe('semantic types reach distinct zones', () => {
  // The regression this whole workstream exists to prevent: semantics
  // collapsing onto one zone and every slide looking the same.
  const MAPPED: Array<[string, string]> = [
    ['contents', 'contents_index'],
    ['summary', 'statement'],
    ['roi', 'metrics_band'],
    ['problem', 'two_column_callout'],
    ['roadmap', 'timeline'],
    ['architecture', 'architecture_panel'],
    ['cta', 'decision_cta'],
  ];

  for (const [semantic, expectedZone] of MAPPED) {
    it(`renders ${semantic} through ${expectedZone}`, async () => {
      const protocol = await compileWithSemantic(semantic, [
        '一つ目の要点を説明します。',
        '二つ目の要点を説明します。',
        '三つ目の要点を説明します。',
      ]);
      const zones = protocol.slides.map((slide: any) => slide.metadata?.bodyZone);
      expect(zones).toContain(expectedZone);
    });
  }
});

describe('region-driven zones still fit their text', () => {
  it('records no overflow for a heavy metrics band', async () => {
    const protocol = await compileWithSemantic(
      'roi',
      Array.from(
        { length: 12 },
        (_, i) => `指標${i + 1}: 前年比 ${i * 7 + 12}% 改善し、運用コストを削減`
      )
    );
    const overflows = protocol.slides.flatMap(
      (slide: any) => slide.metadata?.layoutFit?.overflows ?? []
    );
    expect(overflows).toEqual([]);
  });

  it('emits elements for each populated region', async () => {
    const protocol = await compileWithSemantic('roi', ['要約行', '指標A: 12%', '指標B: 34%']);
    const metricsSlide = protocol.slides.find(
      (slide: any) => slide.metadata?.bodyZone === 'metrics_band'
    );
    expect(metricsSlide).toBeDefined();
    const texts = (metricsSlide.elements || [])
      .map((el: any) => el.text)
      .filter((text: unknown) => typeof text === 'string' && text.trim());
    // Lead line, band header and band body all render.
    expect(texts.length).toBeGreaterThanOrEqual(3);
  });

  // Note: body text reaching a slide is generated by the outline layer, not
  // passed through from the brief, so region-level text selection cannot be
  // driven directly from here. What is observable — and what matters — is that
  // a sparse body still yields a valid, fitted slide rather than empty boxes.
  it('renders a valid slide from a sparse body', async () => {
    const protocol = await compileWithSemantic('roi', ['単一行のみ']);
    const slide = protocol.slides.find((s: any) => s.metadata?.bodyZone === 'metrics_band');
    expect(slide).toBeDefined();
    expect(slide.metadata.layoutFit.overflowCount).toBe(0);
    const rendered = (slide.elements || []).filter(
      (el: any) => typeof el.text === 'string' && el.text.trim().length > 0
    );
    expect(rendered.length).toBeGreaterThan(0);
    for (const element of rendered) {
      expect(element.pos.w).toBeGreaterThan(0);
      expect(element.pos.h).toBeGreaterThan(0);
    }
  });
});
