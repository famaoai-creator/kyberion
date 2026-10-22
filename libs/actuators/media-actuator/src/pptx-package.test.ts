import { describe, expect, it, vi } from 'vitest';
import { logger } from '@agent/core/core';
import {
  assertPptxPackage,
  assertPptxPackageWrite,
  slideRenamePartMap,
  diffPptxPackages,
  inspectPptxPackage,
  resolveRelTarget,
  tokenizeXml,
  type PptxIssueCode,
} from './pptx-package.js';
import { buildTestDeck, slide2Xml } from './pptx-test-deck.test-support.js';

function codes(buffer: Buffer, severity?: 'error' | 'warn'): PptxIssueCode[] {
  return inspectPptxPackage(buffer)
    .issues.filter((issue) => !severity || issue.severity === severity)
    .map((issue) => issue.code);
}

describe('inspectPptxPackage', () => {
  it('accepts a well-formed deck (root _rels/.rels resolves, external hyperlinks are skipped)', () => {
    const report = inspectPptxPackage(buildTestDeck());
    expect(report.ok).toBe(true);
    expect(codes(buildTestDeck(), 'error')).toEqual([]);
  });

  it('warns about co-authoring change history', () => {
    expect(codes(buildTestDeck(), 'warn')).toEqual(['CHANGES_INFO_PRESENT']);
  });

  it('flags a text body without a paragraph (EMPTY_TXBODY)', () => {
    const deck = buildTestDeck((parts) => {
      parts.set(
        'ppt/slides/slide2.xml',
        slide2Xml().replace(
          /<p:txBody>[\s\S]*?<\/p:txBody>/u,
          '<p:txBody><a:bodyPr/><a:lstStyle/></p:txBody>'
        )
      );
    });
    const report = inspectPptxPackage(deck);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'EMPTY_TXBODY',
        part: 'ppt/slides/slide2.xml',
        severity: 'error',
      })
    );
  });

  it('flags a relationship to a missing part (BROKEN_REL)', () => {
    const deck = buildTestDeck((parts) => {
      parts.delete('ppt/media/image1.png');
    });
    expect(inspectPptxPackage(deck).issues).toContainEqual(
      expect.objectContaining({
        code: 'BROKEN_REL',
        part: 'ppt/slides/_rels/slide1.xml.rels',
        detail: expect.stringContaining('ppt/media/image1.png'),
      })
    );
  });

  it('flags an r:embed with no relationship in the slide rels (DANGLING_RID)', () => {
    const deck = buildTestDeck((parts) => {
      parts.set(
        'ppt/slides/slide1.xml',
        String(parts.get('ppt/slides/slide1.xml')).replace('r:embed="rId2"', 'r:embed="rId9"')
      );
    });
    expect(inspectPptxPackage(deck).issues).toContainEqual(
      expect.objectContaining({ code: 'DANGLING_RID', part: 'ppt/slides/slide1.xml' })
    );
  });

  it('flags a slide without its content-type override (MISSING_CONTENT_TYPE)', () => {
    const deck = buildTestDeck((parts) => {
      parts.set(
        '[Content_Types].xml',
        String(parts.get('[Content_Types].xml')).replace(
          /<Override PartName="\/ppt\/slides\/slide2\.xml"[^>]*\/>/u,
          ''
        )
      );
    });
    expect(inspectPptxPackage(deck).issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_CONTENT_TYPE', part: 'ppt/slides/slide2.xml' })
    );
  });

  it('flags duplicate slide ids (DUPLICATE_SLDID)', () => {
    const deck = buildTestDeck((parts) => {
      parts.set(
        'ppt/presentation.xml',
        String(parts.get('ppt/presentation.xml')).replace('id="257"', 'id="256"')
      );
    });
    expect(codes(deck, 'error')).toContain('DUPLICATE_SLDID');
  });

  it('warns about media no relationship references (ORPHAN_PART)', () => {
    const deck = buildTestDeck((parts) => {
      parts.set('ppt/media/image9.png', Buffer.from([1, 2, 3]));
    });
    const report = inspectPptxPackage(deck);
    expect(report.ok).toBe(true);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'ORPHAN_PART',
        part: 'ppt/media/image9.png',
        severity: 'warn',
      })
    );
  });

  it('resolves rels targets against the source part, including the package root', () => {
    expect(resolveRelTarget('_rels/.rels', 'ppt/presentation.xml')).toBe('ppt/presentation.xml');
    expect(resolveRelTarget('ppt/slides/_rels/slide1.xml.rels', '../media/a%20b.png')).toBe(
      'ppt/media/a b.png'
    );
    expect(resolveRelTarget('ppt/_rels/presentation.xml.rels', '/ppt/slides/slide1.xml')).toBe(
      'ppt/slides/slide1.xml'
    );
  });
});

describe('assertPptxPackage', () => {
  it('passes a clean package through and refuses a defective one with a diagnostic', () => {
    expect(assertPptxPackage(buildTestDeck(), 'test').ok).toBe(true);
    const broken = buildTestDeck((parts) => parts.delete('ppt/media/image1.png'));
    expect(() => assertPptxPackage(broken, 'test_writer')).toThrow(
      /^test_writer: refused to write a defective PPTX package — .* \| next: .* \| evidence: BROKEN_REL/u
    );
  });
});

describe('diffPptxPackages', () => {
  it('treats attribute-order-only XML changes as noise', () => {
    const after = buildTestDeck((parts) => {
      parts.set(
        'ppt/presentation.xml',
        String(parts.get('ppt/presentation.xml')).replace(
          '<p:sldSz cx="12192000" cy="6858000"/>',
          '<p:sldSz cy="6858000"  cx="12192000"/>'
        )
      );
    });
    const diff = diffPptxPackages(buildTestDeck(), after);
    expect(diff.changed).toEqual([
      expect.objectContaining({ part: 'ppt/presentation.xml', noise_only: true, tag_diffs: [] }),
    ]);
  });

  it('treats embedded font subset changes as noise and other binary changes as real', () => {
    const before = buildTestDeck((parts) => {
      parts.set('ppt/fonts/font1.fntdata', Buffer.from([1, 2, 3]));
    });
    const after = buildTestDeck((parts) => {
      parts.set('ppt/fonts/font1.fntdata', Buffer.from([1, 2, 3, 4]));
      parts.set('ppt/media/image1.png', Buffer.from([9, 9]));
    });
    const byPart = Object.fromEntries(
      diffPptxPackages(before, after).changed.map((c) => [c.part, c])
    );
    expect(byPart['ppt/fonts/font1.fntdata']).toMatchObject({
      noise_only: true,
      size_before: 3,
      size_after: 4,
    });
    expect(byPart['ppt/media/image1.png']).toMatchObject({ noise_only: false });
  });

  it('aligns tag diffs so one inserted shape is one hunk, not a cascade', () => {
    const after = buildTestDeck((parts) => {
      parts.set(
        'ppt/slides/slide2.xml',
        slide2Xml().replace(
          '</p:spTree>',
          '<p:sp><p:nvSpPr><p:cNvPr id="9" name="Added"/></p:nvSpPr></p:sp></p:spTree>'
        )
      );
      parts.set('ppt/media/image2.png', Buffer.from([7]));
      parts.delete('ppt/changesInfos/changesInfo1.xml');
    });
    const diff = diffPptxPackages(buildTestDeck(), after);
    expect(diff.only_in_after).toEqual(['ppt/media/image2.png']);
    expect(diff.only_in_before).toEqual(['ppt/changesInfos/changesInfo1.xml']);
    const slide = diff.changed.find((c) => c.part === 'ppt/slides/slide2.xml')!;
    expect(slide.noise_only).toBe(false);
    expect(slide.tag_diffs).toHaveLength(1);
    expect(slide.tag_diffs[0]!.before).toBe('');
    expect(slide.tag_diffs[0]!.after).toContain('name="Added"');
  });

  it('reports a text change as a before/after pair and honours the parts glob', () => {
    const after = buildTestDeck((parts) => {
      parts.set('ppt/slides/slide2.xml', slide2Xml().replace('Closing', 'Summary'));
      parts.set(
        'ppt/presentation.xml',
        String(parts.get('ppt/presentation.xml')).replace('id="257"', 'id="300"')
      );
    });
    const diff = diffPptxPackages(buildTestDeck(), after, { parts: 'ppt/slides/*.xml' });
    expect(diff.changed.map((c) => c.part)).toEqual(['ppt/slides/slide2.xml']);
    expect(diff.changed[0]!.tag_diffs).toEqual([{ before: '<a:t>Closing', after: '<a:t>Summary' }]);
  });

  it('tokenises tags with sorted attributes', () => {
    expect(tokenizeXml('<a b="1" a="2"/><c>t</c>')).toEqual(['<a a="2" b="1"/>', '<c>t', '</c>']);
  });
});

describe('package findings follow-up', () => {
  it('reports NULL and #anchor rel targets as warnings, not broken relationships', () => {
    const deck = buildTestDeck((parts) => {
      parts.set(
        'ppt/slides/_rels/slide2.xml.rels',
        String(parts.get('ppt/slides/_rels/slide2.xml.rels')).replace(
          '</Relationships>',
          '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="NULL"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="#slide1"/></Relationships>'
        )
      );
    });
    const report = inspectPptxPackage(deck);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.code === 'BROKEN_REL').map((i) => i.severity)).toEqual([
      'warn',
      'warn',
    ]);
  });

  it('reports any part unreachable from the package root as ORPHAN_PART', () => {
    const deck = buildTestDeck((parts) => {
      parts.set('ppt/charts/chart9.xml', '<c:chartSpace xmlns:c="urn:x"/>');
      parts.set(
        'ppt/charts/_rels/chart9.xml.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
      );
      parts.set(
        '[Content_Types].xml',
        String(parts.get('[Content_Types].xml')).replace(
          '</Types>',
          '<Override PartName="/ppt/charts/chart9.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'
        )
      );
    });
    const orphans = inspectPptxPackage(deck)
      .issues.filter((i) => i.code === 'ORPHAN_PART')
      .map((i) => i.part);
    expect(orphans.sort()).toEqual(['ppt/charts/_rels/chart9.xml.rels', 'ppt/charts/chart9.xml']);
  });

  it('parses <p:sldId> with children and fails closed on an unparseable list', () => {
    const withChildren = buildTestDeck((parts) => {
      parts.set(
        'ppt/presentation.xml',
        String(parts.get('ppt/presentation.xml')).replace(
          '<p:sldId id="257" r:id="rId3"/>',
          '<p:sldId id="256" r:id="rId3"><p:extLst/></p:sldId>'
        )
      );
    });
    // the child-bearing entry is parsed, so its duplicate id is seen
    expect(inspectPptxPackage(withChildren).issues).toContainEqual(
      expect.objectContaining({
        code: 'DUPLICATE_SLDID',
        detail: expect.stringContaining('256 appears 2 times'),
      })
    );
    const unparseable = buildTestDeck((parts) => {
      parts.set(
        'ppt/presentation.xml',
        String(parts.get('ppt/presentation.xml')).replace(
          '<p:sldId id="257" r:id="rId3"/>',
          '<p:sldId id="257" r:id="rId3">'
        )
      );
    });
    expect(inspectPptxPackage(unparseable).issues).toContainEqual(
      expect.objectContaining({
        code: 'DUPLICATE_SLDID',
        detail: expect.stringContaining('could not be parsed'),
      })
    );
  });

  it('write gate: inherited defects pass with a warning, introduced ones refuse, package_check overrides', () => {
    const source = buildTestDeck((parts) => parts.delete('ppt/media/image1.png'));
    const sameDefect = buildTestDeck((parts) => parts.delete('ppt/media/image1.png'));
    const warn = vi.spyOn(logger, 'warn');
    expect(assertPptxPackageWrite(sameDefect, 'edit', { baseline: source }).ok).toBe(false);
    expect(warn.mock.calls.some(([m]) => /inherited from the source deck/u.test(String(m)))).toBe(
      true
    );
    const newDefect = buildTestDeck((parts) => {
      parts.delete('ppt/media/image1.png');
      parts.set(
        'ppt/slides/slide2.xml',
        slide2Xml().replace(/<p:txBody>[\s\S]*?<\/p:txBody>/u, '<p:txBody/>')
      );
    });
    expect(() => assertPptxPackageWrite(newDefect, 'edit', { baseline: source })).toThrow(
      /^edit: refused .*introduced by this write .*evidence: EMPTY_TXBODY ppt\/slides\/slide2\.xml/u
    );
    expect(() =>
      assertPptxPackageWrite(newDefect, 'edit', { baseline: source, level: 'warn' })
    ).not.toThrow();
    expect(() => assertPptxPackageWrite(newDefect, 'edit', { level: 'never' })).not.toThrow();
    expect(() => assertPptxPackageWrite(newDefect, 'render')).toThrow(/2 structural error/u);
    warn.mockRestore();
  });
});

describe('write gate crediting follows the writer part map', () => {
  const emptyBody = (xml: string) =>
    xml.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/u, '<p:txBody><a:bodyPr/></p:txBody>');
  const source = buildTestDeck((parts) =>
    parts.set('ppt/slides/slide2.xml', emptyBody(slide2Xml()))
  );
  // output: the defect now sits on slide 1, which came from a clean slide
  const output = buildTestDeck((parts) =>
    parts.set(
      'ppt/slides/slide1.xml',
      String(parts.get('ppt/slides/slide1.xml')).replace(
        '</p:spTree>',
        '<p:sp><p:nvSpPr><p:cNvPr id="40" name="X"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/></p:txBody></p:sp></p:spTree>'
      )
    )
  );

  it('does not let a defect on a dropped slide excuse a same-code defect elsewhere', () => {
    // filter-style write: slide 1 kept as slide 1, slide 2 dropped
    const partMap = slideRenamePartMap(
      new Map([['ppt/slides/slide1.xml', 'ppt/slides/slide1.xml']])
    );
    expect(() =>
      assertPptxPackageWrite(output, 'pptx_filter_slides', { baseline: source, partMap })
    ).toThrow(/introduced by this write .*EMPTY_TXBODY ppt\/slides\/slide1\.xml/u);
  });

  it('credits an inherited defect that moved with its renamed slide', () => {
    // reorder-style write: old slide 2 (defective) becomes slide 1
    const moved = buildTestDeck((parts) =>
      parts.set('ppt/slides/slide1.xml', emptyBody(String(parts.get('ppt/slides/slide1.xml'))))
    );
    const partMap = slideRenamePartMap(
      new Map([
        ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'],
        ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'],
      ])
    );
    expect(() =>
      assertPptxPackageWrite(moved, 'pptx_filter_slides', { baseline: source, partMap })
    ).not.toThrow();
  });
});

describe('diffPptxPackages relevance and noise', () => {
  it('orders structure first, treats docProps and xmlns / mc:Ignorable changes as noise, and summarises', () => {
    const before = buildTestDeck((parts) => {
      parts.set('docProps/app.xml', '<Properties><Slides>2</Slides></Properties>');
    });
    const after = buildTestDeck((parts) => {
      parts.set('docProps/app.xml', '<Properties><Slides>3</Slides></Properties>');
      parts.set(
        'ppt/theme/theme1.xml',
        String(parts.get('ppt/theme/theme1.xml')).replace('name="Test"', 'name="Other"')
      );
      parts.set('ppt/slides/slide2.xml', slide2Xml().replace('Closing', 'Summary'));
      parts.set(
        'ppt/slides/slide1.xml',
        String(parts.get('ppt/slides/slide1.xml')).replace(
          '<p:sld ',
          '<p:sld xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="p14" '
        )
      );
      parts.set(
        '[Content_Types].xml',
        String(parts.get('[Content_Types].xml')).replace(
          '</Types>',
          '<Default Extension="jpg" ContentType="image/jpeg"/></Types>'
        )
      );
    });
    const diff = diffPptxPackages(before, after);
    expect(diff.changed.map((c) => [c.part, c.noise_only])).toEqual([
      ['[Content_Types].xml', false],
      ['ppt/slides/slide1.xml', true],
      ['ppt/slides/slide2.xml', false],
      ['docProps/app.xml', true],
      ['ppt/theme/theme1.xml', false],
    ]);
    expect(diff.summary).toEqual({
      only_in_before: 0,
      only_in_after: 0,
      changed: 5,
      noise_only: 2,
      significant_parts: ['[Content_Types].xml', 'ppt/slides/slide2.xml', 'ppt/theme/theme1.xml'],
    });
  });
});
