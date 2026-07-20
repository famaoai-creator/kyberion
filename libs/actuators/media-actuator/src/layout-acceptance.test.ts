/**
 * MP-06: acceptance tests for the media layout path.
 *
 * Three shapes of brief historically produced misaligned decks — long
 * Japanese prose, bullet-heavy slides, and mixed table content — and none of
 * them were covered by a test that could tell whether the fix held. These
 * assert the outcome a reader would check: no box overflows, nothing shrinks
 * below the legibility floor, and the same brief renders identically twice.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contrastRatio, WCAG_AA_BODY_TEXT } from '@agent/core';
import { handleAction } from './index.js';

const LONG_JP =
  '本施策では既存の業務プロセスを段階的に自動化し、担当者の確認負荷を下げながら品質を維持します。' +
  '加えて監査証跡を自動で残すため、運用開始後の検証コストも継続的に低減できます。';

/** Long Japanese prose in every field — the case that used to overflow. */
function japaneseHeavyBrief() {
  return baseBrief({
    title: '全社業務プロセス自動化構想',
    objective: LONG_JP,
    story: { core_message: LONG_JP.repeat(2), closing_cta: '本方針の承認をお願いします。' },
    sections: Array.from({ length: 6 }, (_, i) => ({
      title: `検討領域${i + 1}`,
      objective: `${LONG_JP}（領域${i + 1}）`,
      body: [LONG_JP, LONG_JP],
    })),
  });
}

/** Many short bullets — the case the ratio splitter distributed lopsidedly. */
function bulletHeavyBrief() {
  return baseBrief({
    title: '施策一覧',
    objective: '対象施策を一覧で示す。',
    story: { core_message: '施策は全部で20件あります。', closing_cta: '優先順位を決めたい。' },
    sections: Array.from({ length: 4 }, (_, s) => ({
      title: `カテゴリ${s + 1}`,
      objective: '該当施策の一覧',
      body: Array.from({ length: 20 }, (_, i) => `施策${s + 1}-${i + 1}: 対応方針を決定する`),
    })),
  });
}

/** Prose mixed with tabular rows in the same body. */
function mixedTableBrief() {
  return baseBrief({
    title: '実績サマリ',
    objective: '数値実績と所見を併記する。',
    story: { core_message: '前年比で改善しています。', closing_cta: '継続を承認したい。' },
    sections: [
      {
        title: '実績',
        objective: '主要指標の推移',
        body: [
          LONG_JP,
          '指標 | 前年 | 当年 | 差分',
          '処理件数 | 12,400 | 18,900 | +6,500',
          '平均処理時間 | 42分 | 17分 | -25分',
          '手戻り率 | 8.2% | 2.1% | -6.1pt',
          LONG_JP,
        ],
      },
    ],
  });
}

function baseBrief(overrides: Record<string, unknown>) {
  return {
    kind: 'proposal-brief',
    document_profile: 'executive-proposal',
    render_target: 'pptx',
    locale: 'ja-JP',
    ...overrides,
  };
}

async function compile(brief: Record<string, unknown>): Promise<any> {
  const result = await handleAction({
    action: 'pipeline',
    context: { last_json: brief },
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

/** Every overflow recorded across the deck, with its slide for reporting. */
function overflows(protocol: any): Array<{ slide: string; zone: string; fillRatio: number }> {
  return protocol.slides.flatMap((slide: any) =>
    (slide.metadata?.layoutFit?.overflows ?? []).map((entry: any) => ({
      slide: slide.id,
      zone: entry.zone,
      fillRatio: entry.fillRatio,
    }))
  );
}

function bodyFontSizes(protocol: any): number[] {
  return protocol.slides.flatMap((slide: any) =>
    (slide.elements || [])
      .filter((el: any) => typeof el.text === 'string' && el.text.length > 40)
      .map((el: any) => el.style?.fontSize)
      .filter((size: unknown): size is number => typeof size === 'number')
  );
}

const CASES: Array<[string, () => Record<string, unknown>]> = [
  ['long Japanese prose', japaneseHeavyBrief],
  ['bullet-heavy slides', bulletHeavyBrief],
  ['prose mixed with tabular rows', mixedTableBrief],
];

describe('MP-06 text-misalignment regression', () => {
  for (const [label, buildBrief] of CASES) {
    it(`fits every box for ${label}`, async () => {
      const protocol = await compile(buildBrief());
      const found = overflows(protocol);
      // Reported with detail so a regression names the offending zone.
      expect(found, `overflowing boxes: ${JSON.stringify(found)}`).toEqual([]);
    });

    it(`never drops below the legibility floor for ${label}`, async () => {
      const protocol = await compile(buildBrief());
      const sizes = bodyFontSizes(protocol);
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(10);
    });

    it(`reports a layout status for ${label}`, async () => {
      const protocol = await compile(buildBrief());
      const diagnostics = protocol.metadata?.layoutDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(['pass', 'shrunk']).toContain(diagnostics.status);
      expect(diagnostics.overflowCount).toBe(0);
    });
  }
});

describe('MP-06 determinism', () => {
  for (const [label, buildBrief] of CASES) {
    it(`produces an identical protocol twice for ${label}`, async () => {
      const first = await compile(buildBrief());
      const second = await compile(buildBrief());
      // generatedAt is a timestamp by design; everything else must match.
      const stable = (protocol: any) =>
        createHash('sha256')
          .update(JSON.stringify({ ...protocol, generatedAt: null }))
          .digest('hex');
      expect(stable(first)).toBe(stable(second));
    });
  }
});

describe('MP-06 golden-brief layout measurements', () => {
  // Objective proxies for design quality until the MP-04 visual rubric exists.
  // Fit correctness and visual variety are separate axes: a deck can fit every
  // box perfectly and still look monotonous because every semantic type
  // rendered through the same zone.
  async function measure(buildBrief: () => Record<string, unknown>) {
    const protocol = await compile(buildBrief());
    const diagnostics = protocol.metadata.layoutDiagnostics;
    const zones = protocol.slides
      .map((slide: any) => slide.metadata?.bodyZone)
      .filter((zone: unknown): zone is string => typeof zone === 'string' && zone !== 'none');
    const semantics = protocol.slides
      .map((slide: any) => slide.metadata?.semanticType)
      .filter(Boolean);
    return {
      slides: diagnostics.slideCount,
      shrinks: diagnostics.shrinkCount,
      overflows: diagnostics.overflowCount,
      distinctZones: new Set(zones).size,
      distinctSemantics: new Set(semantics).size,
      zones,
    };
  }

  it('fits every golden brief without overflow', async () => {
    for (const [label, buildBrief] of CASES) {
      const measurement = await measure(buildBrief);
      expect(measurement.overflows, `${label} overflowed`).toBe(0);
      expect(measurement.slides).toBeGreaterThan(0);
    }
  });

  it('renders distinct semantic types through distinct zones', async () => {
    // The expressiveness guard. Before the zone work every semantic type
    // outside the five mapped ones collapsed onto single_column, so a deck of
    // eight distinct semantics rendered as two or three visual shapes. This
    // asserts variety keeps pace with the semantics the outline produces.
    for (const [label, buildBrief] of CASES) {
      const measurement = await measure(buildBrief);
      expect(
        measurement.distinctZones,
        `${label}: ${measurement.distinctSemantics} semantic types collapsed onto ${measurement.distinctZones} zones (${[...new Set(measurement.zones)].join(', ')})`
      ).toBeGreaterThanOrEqual(6);
    }
  });

  it('records the body zone on every content slide', async () => {
    const protocol = await compile(japaneseHeavyBrief());
    const contentSlides = protocol.slides.filter(
      (slide: any) => slide.metadata?.semanticType !== 'hero'
    );
    expect(contentSlides.length).toBeGreaterThan(0);
    for (const slide of contentSlides) {
      expect(typeof slide.metadata?.bodyZone).toBe('string');
      expect(slide.metadata.bodyZone).not.toBe('none');
    }
  });
});

describe('MP-06 legibility', () => {
  // Found by rendering the deck and looking at it: four slides emitted body
  // text whose color equalled its own fill. Every layout check passed — the
  // text fit its box perfectly and was simply invisible.
  it('never emits text whose color matches its fill', async () => {
    for (const [label, buildBrief] of CASES) {
      const protocol = await compile(buildBrief());
      const invisible = protocol.slides.flatMap((slide: any) =>
        (slide.elements || [])
          .filter(
            (el: any) =>
              typeof el.text === 'string' &&
              el.text.trim() &&
              el.style?.fill &&
              el.style?.color &&
              String(el.style.fill).toLowerCase().replace('#', '') ===
                String(el.style.color).toLowerCase().replace('#', '')
          )
          .map((el: any) => ({ slide: slide.id, text: String(el.text).slice(0, 24) }))
      );
      expect(invisible, `${label}: invisible text on ${JSON.stringify(invisible)}`).toEqual([]);
    }
  });

  it('keeps every filled text element above the AA contrast floor', async () => {
    const protocol = await compile(japaneseHeavyBrief());
    for (const slide of protocol.slides) {
      for (const element of slide.elements || []) {
        if (!element.style?.fill || !element.style?.color) continue;
        if (typeof element.text !== 'string' || !element.text.trim()) continue;
        const ratio = contrastRatio(element.style.color, element.style.fill);
        if (ratio === null) continue;
        expect(ratio, `${slide.id}: "${String(element.text).slice(0, 20)}"`).toBeGreaterThanOrEqual(
          WCAG_AA_BODY_TEXT
        );
      }
    }
  });
});
