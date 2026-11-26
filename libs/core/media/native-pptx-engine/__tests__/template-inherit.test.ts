import { describe, expect, it } from 'vitest';
import type { PptxDesignProtocol, PptxElement } from '../../../contracts/pptx-protocol.js';
import { inheritPptxTemplate } from '../template-inherit.js';

const TEXT: PptxElement = {
  type: 'text',
  pos: { x: 0.5, y: 1.5, w: 9, h: 1 },
  text: 'New body',
};

function templateDesign(): PptxDesignProtocol {
  return {
    version: '3.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: { accent1: '336699' },
    master: { elements: [] },
    rawThemeXml: '<a:theme/>',
    rawMasterXml: '<p:sldMaster/>',
    rawMasters: [{ xml: '<p:sldMaster/>', relsXml: '<Relationships/>' }],
    rawLayouts: [
      { name: 'Title Slide', type: 'title', xml: '<p:sldLayout/>' },
      { name: 'Title and Content', type: 'obj', xml: '<p:sldLayout/>' },
      { name: 'Title Only', type: 'titleOnly', xml: '<p:sldLayout/>' },
    ],
    masterMedia: [{ fileName: 'image1.png', data: 'AAAA' }],
    rawParts: { 'ppt/presentation.xml': 'AAAA' },
    slides: [
      {
        id: 'slide1.xml',
        layoutIndex: 1,
        elements: [{ ...TEXT, text: 'Old title', pXmlLst: ['<a:p/>'] }],
        rawSlideXml: '<p:sld/>',
        rawSlideRelsXml: '<Relationships/>',
        notesXml: '<p:notes/>',
      },
      { id: 'slide2.xml', layoutIndex: 3, elements: [], rawSlideXml: '<p:sld/>' },
    ],
  };
}

describe('inheritPptxTemplate', () => {
  it('keeps masters, layouts, theme and media and drops rawParts and source slides', () => {
    const { design, layoutIndices } = inheritPptxTemplate(templateDesign(), [
      { elements: [TEXT], layoutIndex: 2 },
    ]);
    expect(design.rawParts).toBeUndefined();
    expect(design.rawMasters).toHaveLength(1);
    expect(design.rawLayouts).toHaveLength(3);
    expect(design.rawThemeXml).toBe('<a:theme/>');
    expect(design.masterMedia).toEqual([{ fileName: 'image1.png', data: 'AAAA' }]);
    expect(design.canvas).toEqual({ w: 10, h: 7.5 });
    expect(design.slides).toEqual([{ id: 'slide1.xml', elements: [TEXT], layoutIndex: 2 }]);
    expect(layoutIndices).toEqual([2]);
  });

  it('resolves the layout from a template slide, a layout name, or the bounded default', () => {
    const { design } = inheritPptxTemplate(templateDesign(), [
      { elements: [], layout_from_slide: 2 },
      { elements: [], layout_name: 'Title and Content' },
      { elements: [] },
      { elements: [] },
    ]);
    expect(design.slides.map((s) => s.layoutIndex)).toEqual([3, 2, 2, 2]);

    const single = templateDesign();
    single.rawLayouts = single.rawLayouts!.slice(0, 1);
    const bounded = inheritPptxTemplate(single, [{ elements: [] }, { elements: [] }]);
    expect(bounded.layoutIndices).toEqual([1, 1]);
  });

  it('strips source-deck paragraph XML and raw slide fields from given slides', () => {
    const { design } = inheritPptxTemplate(templateDesign(), [
      {
        elements: [{ ...TEXT, pXmlLst: ['<a:p/>'] }],
        layoutIndex: 1,
        notes: 'Speaker note',
        rawSlideXml: '<p:sld/>',
      } as never,
    ]);
    expect(design.slides[0].elements[0]).not.toHaveProperty('pXmlLst');
    expect(design.slides[0]).not.toHaveProperty('rawSlideXml');
    expect(design.slides[0].notes).toBe('Speaker note');
  });

  it('never mutates its inputs', () => {
    const template = templateDesign();
    const slides = [{ elements: [{ ...TEXT, pXmlLst: ['<a:p/>'] }], layout_from_slide: 1 }];
    const before = JSON.stringify({ template, slides });
    const { design } = inheritPptxTemplate(template, slides);
    expect(JSON.stringify({ template, slides })).toBe(before);
    design.rawLayouts![0].name = 'changed';
    expect(template.rawLayouts![0].name).toBe('Title Slide');
  });

  it('rejects a missing design, a design without layouts, and empty slides', () => {
    expect(() => inheritPptxTemplate(undefined, [{ elements: [] }])).toThrow(
      /no template design was given/u
    );
    const generated = templateDesign();
    delete generated.rawLayouts;
    expect(() => inheritPptxTemplate(generated, [{ elements: [] }])).toThrow(/no raw layouts/u);
    const noMaster = templateDesign();
    delete noMaster.rawMasters;
    delete noMaster.rawMasterXml;
    expect(() => inheritPptxTemplate(noMaster, [{ elements: [] }])).toThrow(/no raw slide master/u);
    expect(() => inheritPptxTemplate(templateDesign(), [])).toThrow(/no slides were given/u);
    expect(() => inheritPptxTemplate(templateDesign(), [{} as never])).toThrow(
      /slides\[0\] has no elements array/u
    );
  });

  it('names the valid range when a layout does not exist', () => {
    expect(() => inheritPptxTemplate(templateDesign(), [{ elements: [], layoutIndex: 4 }])).toThrow(
      /layout 4, which the template does not have .*1\.\.3 \(1=Title Slide, 2=Title and Content, 3=Title Only\)/u
    );
    expect(() =>
      inheritPptxTemplate(templateDesign(), [{ elements: [], layout_from_slide: 5 }])
    ).toThrow(/template slide number in 1\.\.2/u);
    expect(() =>
      inheritPptxTemplate(templateDesign(), [{ elements: [], layout_name: 'Missing' }])
    ).toThrow(/'Missing' is not a layout .*3=Title Only/u);
    expect(() =>
      inheritPptxTemplate(templateDesign(), [{ elements: [], layoutIndex: 1, layout_name: 'X' }])
    ).toThrow(/more than once/u);
  });
});
