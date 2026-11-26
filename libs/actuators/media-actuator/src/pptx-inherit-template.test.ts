import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { handleAction } from './index.js';
import type { MediaAction } from './media-pipeline-helpers.js';
import { buildTestDeck, unzipText } from './pptx-test-deck.test-support.js';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * The shared fixture deck plus a second layout ("Title Only") used by slide 2.
 * The master's layout ids (2147483649, 2147483650) are the values a naive
 * master-id allocation would reuse.
 */
function twoLayoutDeck(): Buffer {
  return buildTestDeck((parts) => {
    parts.set(
      'ppt/slideLayouts/slideLayout2.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout ${NS} type="titleOnly"><p:cSld name="Title Only"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`
    );
    parts.set(
      'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
    );
    parts.set(
      'ppt/slideMasters/slideMaster1.xml',
      String(parts.get('ppt/slideMasters/slideMaster1.xml')).replace(
        '</p:sldLayoutIdLst>',
        '<p:sldLayoutId id="2147483650" r:id="rId3"/></p:sldLayoutIdLst>'
      )
    );
    parts.set(
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      String(parts.get('ppt/slideMasters/_rels/slideMaster1.xml.rels')).replace(
        '</Relationships>',
        `<Relationship Id="rId3" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>`
      )
    );
    parts.set(
      '[Content_Types].xml',
      String(parts.get('[Content_Types].xml')).replace(
        '</Types>',
        '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/></Types>'
      )
    );
    parts.set(
      'ppt/slides/_rels/slide2.xml.rels',
      String(parts.get('ppt/slides/_rels/slide2.xml.rels')).replace(
        'slideLayout1.xml',
        'slideLayout2.xml'
      )
    );
  });
}

const ids = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<p:${tag}\\b[^>]*?\\bid="(\\d+)"`, 'g'))].map((m) => m[1]);

describe('media:pptx_inherit_template', () => {
  const dir = pathResolver.sharedTmp(`pptx-inherit-template-${process.pid}`);
  const source = `${dir}/template.pptx`;
  const out = `${dir}/inherited.pptx`;

  beforeAll(() => {
    safeMkdir(dir, { recursive: true });
    safeWriteFile(source, twoLayoutDeck());
  });
  afterAll(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('extract -> inherit -> render -> package_check builds new slides on the template layouts', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        new_slides: [
          {
            layout_from_slide: 2,
            notes: 'Speaker note for the new slide',
            elements: [
              { type: 'text', pos: { x: 0.5, y: 1.5, w: 9, h: 1 }, text: 'Inherited body A' },
            ],
          },
          {
            layoutIndex: 1,
            elements: [
              { type: 'text', pos: { x: 0.5, y: 1.5, w: 9, h: 1 }, text: 'Inherited body B' },
            ],
          },
        ],
      },
      steps: [
        { type: 'capture', op: 'pptx_extract', params: { path: source, export_as: 'template' } },
        {
          type: 'transform',
          op: 'pptx_inherit_template',
          params: { from: 'template', slides_from: 'new_slides' },
        },
        { type: 'apply', op: 'pptx_render', params: { path: out } },
        { type: 'capture', op: 'pptx_package_check', params: { path: out, fail_on: 'warn' } },
      ],
    } as MediaAction);

    expect(result.status).toBe('succeeded');
    expect(result.context.pptx_package_check).toMatchObject({ ok: true, issues: [] });
    expect(result.context.last_pptx_design.rawParts).toBeUndefined();
    // the extracted template in ctx is left untouched
    expect(result.context.template.rawParts).toBeDefined();
    expect(result.context.template.slides).toHaveLength(2);

    const files = unzipText(safeReadFile(out, { encoding: null }) as Buffer);
    const presentation = files.get('ppt/presentation.xml')!;
    expect(ids(presentation, 'sldId')).toHaveLength(2);
    expect(files.get('ppt/slides/_rels/slide1.xml.rels')).toContain(
      'slideLayouts/slideLayout2.xml'
    );
    expect(files.get('ppt/slides/_rels/slide2.xml.rels')).toContain(
      'slideLayouts/slideLayout1.xml'
    );
    expect(files.get('ppt/slideLayouts/slideLayout2.xml')).toContain('name="Title Only"');
    expect(files.get('ppt/slides/slide1.xml')).toContain('Inherited body A');
    expect(files.get('ppt/slides/slide1.xml')).not.toContain('Section heading');
    expect(files.get('ppt/notesSlides/notesSlide1.xml')).toContain(
      'Speaker note for the new slide'
    );

    const masterIds = ids(presentation, 'sldMasterId');
    const layoutIds = ids(files.get('ppt/slideMasters/slideMaster1.xml')!, 'sldLayoutId');
    expect(layoutIds).toEqual(['2147483649', '2147483650']);
    expect(masterIds).toHaveLength(1);
    expect(layoutIds).not.toContain(masterIds[0]);
  });

  it('fails the step naming the valid layout range', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        { type: 'capture', op: 'pptx_extract', params: { path: source } },
        {
          type: 'transform',
          op: 'pptx_inherit_template',
          params: { slides: [{ layoutIndex: 3, elements: [] }] },
        },
      ],
    } as MediaAction);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toMatch(/use a layout index in 1\.\.2/u);
  });

  it('fails when the template design is missing from the context', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'pptx_inherit_template',
          params: { from: 'nowhere', slides: [{ elements: [] }] },
        },
      ],
    } as MediaAction);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toMatch(/could not find context key: nowhere/u);
  });
});
