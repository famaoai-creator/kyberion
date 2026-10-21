import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { inspectPptxPackage, parseRelationships, readAttr } from './pptx-package.js';
import {
  replacePptxSlides,
  resolveReplaceSlidesTheme,
  type ReplacementSlide,
  type ReplaceSlidesTheme,
} from './pptx-replace-slides.js';
import { opApply } from './media-action-apply.js';
import { opCapture } from './media-action-capture.js';
import { renderCompiledProtocol } from './media-design-protocol.js';
import {
  buildTestDeck,
  buildTestDeckParts,
  slide2Xml,
  TEST_FOOTER_TOP,
  unzipText,
} from './pptx-test-deck.test-support.js';

const THEME: ReplaceSlidesTheme = resolveReplaceSlidesTheme({
  colors: {
    primary: '#1F3864',
    accent: '#4F81BD',
    surface: '#EAF0F8',
    muted_text: '#595959',
    danger: '#C0504D',
    background: '#FFFFFF',
  },
  fonts: { body: "Inter, 'Noto Sans JP', sans-serif" },
});

const SLIDES: ReplacementSlide[] = [
  {
    subtitle: 'Overview (1/2)',
    blocks: [
      { type: 'lead', text: 'One sentence that frames the page' },
      {
        type: 'kpi_band',
        items: [
          { label: 'Metric A', value: '42', note: 'note a' },
          { label: 'Metric B', value: '7%', note: 'note b' },
          { label: 'Metric C', value: '1.5x' },
        ],
      },
      {
        type: 'labeled_rows',
        title: 'Open questions',
        rows: [
          { label: 'Topic one', text: 'Short description' },
          { label: 'Topic two', text: 'Another description' },
        ],
      },
    ],
  },
  {
    subtitle: 'Plan (2/2)',
    blocks: [
      { type: 'lead', text: 'Second page message' },
      {
        type: 'columns',
        ratio: [4, 6],
        left: [
          {
            type: 'trend_chart',
            x_label: 'Volume',
            y_label: 'Cost',
            series: [
              { label: 'Before', trend: 'rising', style: 'dashed', tone: 'negative' },
              { label: 'After', trend: 'flat', style: 'solid', tone: 'primary' },
            ],
          },
        ],
        right: [
          {
            type: 'labeled_rows',
            rows: [
              { label: 'Step one', text: 'Do the first thing' },
              { label: 'Step two', text: 'Then the next' },
            ],
          },
        ],
      },
      {
        type: 'card_row',
        items: [
          { title: 'Card A', text: 'Detail a' },
          { title: 'Card B', text: 'Detail b' },
        ],
      },
    ],
  },
];

function slideOrder(parts: Map<string, string>): Array<{ id: number; rid: string; part: string }> {
  const rels = parseRelationships(parts.get('ppt/_rels/presentation.xml.rels')!);
  return [...parts.get('ppt/presentation.xml')!.matchAll(/<p:sldId\b[^>]*\/>/gu)].map((m) => {
    const rid = readAttr(m[0], 'r:id')!;
    return {
      id: Number(readAttr(m[0], 'id')),
      rid,
      part: `ppt/${rels.find((r) => r.id === rid)!.target}`,
    };
  });
}

function shapeBottoms(xml: string): number[] {
  return [...xml.matchAll(/<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/gu)].map(
    (m) => Number(m[1]) + Number(m[2])
  );
}

describe('replacePptxSlides', () => {
  const result = replacePptxSlides(buildTestDeck(), {
    replace_index: 1,
    subtitle_shape: 'Subtitle 2',
    theme: THEME,
    slides: SLIDES,
  });
  const parts = unzipText(result.buffer);

  it('produces a package with no integrity issues at all', () => {
    expect(inspectPptxPackage(result.buffer)).toEqual({ ok: true, issues: [] });
  });

  it('inserts the new slides in place with unique slide ids >= 256 and unique rIds', () => {
    const order = slideOrder(parts);
    expect(order.map((s) => s.part)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide2.xml',
    ]);
    expect(new Set(order.map((s) => s.id)).size).toBe(3);
    expect(order.every((s) => s.id >= 256)).toBe(true);
    const relIds = parseRelationships(parts.get('ppt/_rels/presentation.xml.rels')!).map(
      (r) => r.id
    );
    expect(new Set(relIds).size).toBe(relIds.length);
    expect(parts.get('[Content_Types].xml')).toContain('PartName="/ppt/slides/slide3.xml"');
  });

  it('removes change history (part, relationship and content-type override)', () => {
    expect([...parts.keys()].some((name) => name.startsWith('ppt/changesInfos/'))).toBe(false);
    expect(parts.get('ppt/_rels/presentation.xml.rels')).not.toContain('changesInfo');
    expect(parts.get('[Content_Types].xml')).not.toContain('changesInfo');
    expect(result.removed_parts).toContain('ppt/changesInfos/changesInfo1.xml');
  });

  it('removes media only the replaced slide used', () => {
    expect(parts.has('ppt/media/image1.png')).toBe(false);
    expect(result.removed_parts).toContain('ppt/media/image1.png');
  });

  it('removes the chart, its embedded workbook and comments only the replaced slide used', () => {
    for (const part of [
      'ppt/charts/chart1.xml',
      'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx',
      'ppt/comments/modernComment_1.xml',
    ]) {
      expect(parts.has(part), part).toBe(false);
      expect(result.removed_parts).toContain(part);
    }
    expect(parts.has('ppt/charts/_rels/chart1.xml.rels')).toBe(false);
    expect(parts.get('[Content_Types].xml')).not.toContain('/ppt/charts/chart1.xml');
    expect(parts.get('[Content_Types].xml')).not.toContain('modernComment');
    // the notes slide and the layout chain survive the cleanup
    expect(parts.has('ppt/notesSlides/notesSlide1.xml')).toBe(true);
    expect(parts.has('ppt/slideLayouts/slideLayout1.xml')).toBe(true);
  });

  it('does not copy the template slide comments onto generated slides', () => {
    // replace slide 2 using slide 1 (which keeps its chart and comment) as template
    const other = replacePptxSlides(buildTestDeck(), {
      replace_index: 2,
      template_index: 1,
      subtitle_shape: 'Subtitle 2',
      theme: THEME,
      slides: SLIDES,
    });
    const out = unzipText(other.buffer);
    expect(inspectPptxPackage(other.buffer).issues.filter((i) => i.severity === 'error')).toEqual(
      []
    );
    for (const name of ['ppt/slides/slide2.xml', 'ppt/slides/slide3.xml']) {
      expect(out.get(name)).not.toContain('commentRel');
      expect(out.get(name.replace('slides/', 'slides/_rels/') + '.rels')).not.toContain('comments');
    }
    // the template keeps its own comment and chart
    expect(out.has('ppt/comments/modernComment_1.xml')).toBe(true);
    expect(out.has('ppt/charts/chart1.xml')).toBe(true);
  });

  it('parses slide ids written with child elements and fails closed on an unparseable list', () => {
    const withChildren = buildTestDeck((p) =>
      p.set(
        'ppt/presentation.xml',
        String(p.get('ppt/presentation.xml')).replace(
          '<p:sldId id="257" r:id="rId3"/>',
          '<p:sldId id="257" r:id="rId3"><p:extLst/></p:sldId>'
        )
      )
    );
    const ok = replacePptxSlides(withChildren, {
      replace_index: 2,
      theme: THEME,
      slides: [{ blocks: [{ type: 'lead', text: 'a' }] }],
    });
    expect(inspectPptxPackage(ok.buffer).ok).toBe(true);
    const broken = buildTestDeck((p) =>
      p.set(
        'ppt/presentation.xml',
        String(p.get('ppt/presentation.xml')).replace(
          '<p:sldId id="257" r:id="rId3"/>',
          '<p:sldId id="257" r:id="rId3">'
        )
      )
    );
    expect(() =>
      replacePptxSlides(broken, {
        replace_index: 1,
        theme: THEME,
        slides: [{ blocks: [{ type: 'lead', text: 'a' }] }],
      })
    ).toThrow(/cannot read the slide list/u);
  });

  it('keeps notes on the first slide only and reuses the template layout', () => {
    const first = parseRelationships(parts.get('ppt/slides/_rels/slide1.xml.rels')!);
    const second = parseRelationships(parts.get('ppt/slides/_rels/slide3.xml.rels')!);
    expect(first.map((r) => r.type.split('/').pop()).sort()).toEqual(['notesSlide', 'slideLayout']);
    expect(second.map((r) => r.type.split('/').pop())).toEqual(['slideLayout']);
    expect(second[0]!.target).toBe('../slideLayouts/slideLayout1.xml');
  });

  it('keeps the head shapes, replaces the subtitle in its first run and drops the old body', () => {
    const slide = parts.get('ppt/slides/slide1.xml')!;
    expect(slide).toContain('name="Title 1"');
    expect(slide).toContain('<a:rPr sz="2000" b="1"/><a:t>Overview (1/2)</a:t>');
    expect(slide).not.toContain('subtitle</a:t>');
    expect(slide).not.toContain('Body text that will be replaced');
    expect(slide).not.toContain('<p:timing');
    expect(parts.get('ppt/slides/slide3.xml')).toContain('<a:t>Plan (2/2)</a:t>');
  });

  it('lays blocks in the body zone with theme colours and fonts, above the footer', () => {
    for (const name of ['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml']) {
      const xml = parts.get(name)!;
      expect(Math.max(...shapeBottoms(xml))).toBeLessThan(TEST_FOOTER_TOP);
      expect(xml).toContain('<a:srgbClr val="1F3864"/>');
      expect(xml).toContain('<a:latin typeface="Inter"/><a:ea typeface="Noto Sans JP"/>');
      const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/gu)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(result.body_zone.y).toBeGreaterThanOrEqual(1400000);
    // unused master footer placeholder and an empty layout text box do not shrink the zone
    expect(result.body_zone.y + result.body_zone.h).toBeGreaterThan(6_100_000);
    expect(parts.get('ppt/slides/slide3.xml')).toContain('<a:prstDash val="dash"/>');
  });

  it('refuses blocks that do not fit with a diagnostic instead of overlapping', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      type: 'lead' as const,
      text: `Line ${i}`,
    }));
    expect(() =>
      replacePptxSlides(buildTestDeck(), {
        replace_index: 1,
        theme: THEME,
        slides: [{ blocks: many }],
      })
    ).toThrow(/slide 1 overflows the body zone — .* \| next: .* \| evidence: lead=/u);
  });

  it('refuses a subtitle without a subtitle_shape and an unknown block type', () => {
    expect(() =>
      replacePptxSlides(buildTestDeck(), {
        replace_index: 1,
        theme: THEME,
        slides: [{ subtitle: 'x', blocks: [{ type: 'lead', text: 'a' }] }],
      })
    ).toThrow(/subtitle given without subtitle_shape/u);
    expect(() =>
      replacePptxSlides(buildTestDeck(), {
        replace_index: 1,
        theme: THEME,
        slides: [{ blocks: [{ type: 'table' } as never] }],
      })
    ).toThrow(/unknown block type 'table'/u);
  });
});

describe('replacePptxSlides write gate', () => {
  it('a defect on the overwritten slide does not excuse a same-code defect the write copies in', () => {
    const deck = buildTestDeck((p) => {
      // replaced slide 1: defective body shape (dropped by the replacement)
      p.set(
        'ppt/slides/slide1.xml',
        String(p.get('ppt/slides/slide1.xml')).replace(
          /(name="Body 3"[\s\S]*?)<p:txBody>[\s\S]*?<\/p:txBody>/u,
          '$1<p:txBody><a:bodyPr/></p:txBody>'
        )
      );
      // template slide 2: defective head shape that is cloned into the new slides
      p.set(
        'ppt/slides/slide2.xml',
        slide2Xml().replace(
          '</p:spTree>',
          '<p:sp><p:nvSpPr><p:cNvPr id="40" name="Head Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="9000000" y="300000"/><a:ext cx="1000000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/></p:txBody></p:sp></p:spTree>'
        )
      );
    });
    expect(() =>
      replacePptxSlides(deck, {
        replace_index: 1,
        template_index: 2,
        theme: THEME,
        slides: [{ blocks: [{ type: 'lead', text: 'a' }] }],
      })
    ).toThrow(/introduced by this write .*EMPTY_TXBODY ppt\/slides\/slide1\.xml/u);
  });
});

describe('resolveReplaceSlidesTheme', () => {
  it('reads a tenant theme pack and falls back for missing keys', () => {
    const theme = resolveReplaceSlidesTheme(
      { theme: { colors: { primary: '#123456', accent: '#abc' } } },
      { colors: { danger: '#990000' } }
    );
    expect(theme).toMatchObject({
      primary: '123456',
      accent: 'AABBCC',
      negative: '990000',
      onPrimary: 'FFFFFF',
    });
    expect(theme.pale).toMatch(/^[0-9A-F]{6}$/u);
  });
});

describe('media actuator PPTX package ops', () => {
  const dir = pathResolver.sharedTmp(`pptx-package-ops-${process.pid}`);
  const source = `${dir}/source.pptx`;
  const resolve = (value: unknown) => value;
  const runApply = (op: string, params: Record<string, unknown>) =>
    opApply(op, params, {}, resolve);
  const runCapture = (op: string, params: Record<string, unknown>) =>
    opCapture(op, params, {}, resolve);

  beforeAll(() => {
    safeMkdir(dir, { recursive: true });
    safeWriteFile(source, buildTestDeck());
  });
  afterAll(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('pptx_replace_slides writes a clean deck that pptx_package_check accepts', async () => {
    const out = `${dir}/replaced.pptx`;
    const ctx = await runApply('pptx_replace_slides', {
      path: source,
      out,
      replace_index: 1,
      subtitle_shape: 'Subtitle 2',
      theme: { colors: { primary: '#224466', accent: '#3366AA' } },
      slides: SLIDES,
    });
    expect(ctx.pptx_replace_slides.slide_parts).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide3.xml',
    ]);
    const check = await runCapture('pptx_package_check', { path: out, fail_on: 'warn' });
    expect(check.pptx_package_check).toMatchObject({ ok: true, issues: [] });
    const diff = await runCapture('pptx_package_diff', {
      before: source,
      after: out,
      export_as: 'd',
    });
    expect(diff.d.only_in_after).toEqual([
      'ppt/slides/_rels/slide3.xml.rels',
      'ppt/slides/slide3.xml',
    ]);
  });

  it('pptx_package_check fails on warnings only when asked', async () => {
    await expect(runCapture('pptx_package_check', { path: source })).resolves.toMatchObject({
      pptx_package_check: { ok: true },
    });
    await expect(
      runCapture('pptx_package_check', { path: source, fail_on: 'warn' })
    ).rejects.toThrow(/CHANGES_INFO_PRESENT/u);
  });

  it('pptx_patch writes through a defect inherited from the source deck', async () => {
    const broken = `${dir}/broken.pptx`;
    const out = `${dir}/patched.pptx`;
    safeWriteFile(
      broken,
      buildTestDeck((p) =>
        p.set(
          'ppt/slides/slide2.xml',
          slide2Xml().replace(/<p:txBody>[\s\S]*?<\/p:txBody>/u, '<p:txBody><a:bodyPr/></p:txBody>')
        )
      )
    );
    const warn = vi.spyOn(logger, 'warn');
    await runApply('pptx_patch', {
      source: broken,
      path: out,
      replacements: { 'Section heading': 'Heading' },
    });
    expect(safeExistsSync(out)).toBe(true);
    expect(
      warn.mock.calls.some(([m]) =>
        /inherited from the source deck .*EMPTY_TXBODY/u.test(String(m))
      )
    ).toBe(true);
    warn.mockRestore();
  });

  it('pptx_replace_slides refuses a defect it introduces unless package_check overrides', async () => {
    const out = `${dir}/introduced.pptx`;
    // A subtitle shape whose text body is self-closing gets an empty body copied
    // into every generated slide: a defect introduced by the write, not the source.
    const params = {
      path: source,
      out,
      replace_index: 2,
      template_index: 1,
      slides: [{ blocks: [{ type: 'lead', text: 'a' }] }],
    };
    const sourceWithBadTemplate = `${dir}/bad-template.pptx`;
    safeWriteFile(
      sourceWithBadTemplate,
      buildTestDeck((p) => {
        // slide 1 (template) keeps a txBody-less shape inside the head band, slide 2 is clean
        p.set(
          'ppt/slides/slide1.xml',
          String(p.get('ppt/slides/slide1.xml')).replace(
            '</p:spTree>',
            '<p:sp><p:nvSpPr><p:cNvPr id="40" name="Head Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="9000000" y="300000"/><a:ext cx="1000000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/></p:txBody></p:sp></p:spTree>'
          )
        );
      })
    );
    await expect(
      runApply('pptx_replace_slides', { ...params, path: sourceWithBadTemplate })
    ).rejects.toThrow(/introduced by this write .*EMPTY_TXBODY ppt\/slides\/slide2\.xml/u);
    expect(safeExistsSync(out)).toBe(false);
    await runApply('pptx_replace_slides', {
      ...params,
      path: sourceWithBadTemplate,
      package_check: 'warn',
    });
    expect(safeExistsSync(out)).toBe(true);
  });
});

describe('brief-based PPTX render goes through the package gate', () => {
  const dir = pathResolver.sharedTmp(`pptx-brief-gate-${process.pid}`);
  afterAll(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('refuses a defective package unless package_check overrides', async () => {
    // rawParts protocol without [Content_Types].xml: the engine would write a package PowerPoint cannot open
    const compiled = {
      protocolKind: 'pptx' as const,
      protocol: {
        version: '3.0.0',
        canvas: { w: 10, h: 7.5 },
        slides: [{ id: 'slide1.xml', elements: [], rawSlideXml: slide2Xml() }],
        rawParts: {
          '_rels/.rels': Buffer.from(String(buildTestDeckParts().get('_rels/.rels'))).toString(
            'base64'
          ),
        },
      },
    };
    const out = `${dir}/brief.pptx`;
    await expect(renderCompiledProtocol(compiled, out)).rejects.toThrow(
      /pptx brief render: refused to write a defective PPTX package — .*MISSING_CONTENT_TYPE/u
    );
    expect(safeExistsSync(out)).toBe(false);
    await renderCompiledProtocol(compiled, out, { package_check: 'never' });
    expect(safeExistsSync(out)).toBe(true);
  });
});
