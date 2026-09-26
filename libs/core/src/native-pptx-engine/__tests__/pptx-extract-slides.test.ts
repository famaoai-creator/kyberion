/**
 * extractPptxSlides — presentation order, hidden slides, tables, notes and
 * paragraph breaks. The deck is synthesized with generateNativePptx and then
 * edited at the OOXML level to model what PowerPoint produces for real decks
 * (reordered slides keep their file names; tables live in graphic frames).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { extractPptxSlides, generateNativePptx } from '../engine.js';
import { pathResolver } from '../../../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync } from '../../../secure-io.js';
import type { PptxDesignProtocol } from '../../types/pptx-protocol.js';

const THEME = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: '5B9BD5',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '4472C4',
  accent6: '70AD47',
  hlink: '0563C1',
  folHlink: '954F72',
};

function protocol(): PptxDesignProtocol {
  const text = (value: string, y: number) => ({
    type: 'text' as const,
    pos: { x: 1, y, w: 8, h: 1 },
    text: value,
    style: { fontSize: 14, color: '#000000' },
  });
  return {
    version: '3.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: THEME,
    master: { elements: [] },
    slides: ['Alpha', 'Bravo', 'Charlie'].map((title, i) => ({
      id: `slide${i + 1}.xml`,
      backgroundFill: '#FFFFFF',
      elements: [text(title, 0.5)],
    })),
  };
}

const TABLE_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
  '<a:tbl><a:tblGrid><a:gridCol w="50"/><a:gridCol w="50"/></a:tblGrid>' +
  '<a:tr h="10"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>科目</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>金額</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  '<a:tr h="10"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>売上高</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>41,593</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';

const NOTES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Speaker line one</a:t></a:r></a:p><a:p><a:r><a:t>Speaker line two</a:t></a:r></a:p></p:txBody></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp>' +
  '</p:spTree></p:cSld></p:notes>';

describe('extractPptxSlides — real-deck structure', () => {
  let workDir = '';
  let deckPath = '';

  beforeAll(async () => {
    workDir = pathResolver.sharedTmp(`pptx-extract-slides-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    const generated = path.join(workDir, 'generated.pptx');
    await generateNativePptx(protocol(), generated);

    const zip = new AdmZip(generated);
    const read = (name: string) => zip.getEntry(name)!.getData().toString('utf8');
    const write = (name: string, xml: string) => zip.updateFile(name, Buffer.from(xml, 'utf8'));

    // Deck order: slide3, slide1, slide2 (file names unchanged, as PowerPoint does).
    const presentation = read('ppt/presentation.xml');
    const ids = presentation.match(/<p:sldId\b[^>]*\/>/g)!;
    write(
      'ppt/presentation.xml',
      presentation.replace(
        /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        `<p:sldIdLst>${[ids[2], ids[0], ids[1]].join('')}</p:sldIdLst>`
      )
    );
    // slide2 hidden; slide1 gains a two-paragraph shape and a table.
    write(
      'ppt/slides/slide2.xml',
      read('ppt/slides/slide2.xml').replace('<p:sld ', '<p:sld show="0" ')
    );
    const agenda =
      '<p:sp><p:nvSpPr><p:cNvPr id="91" name="Agenda"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>' +
      '<a:p><a:r><a:t>1. Resolutions</a:t></a:r></a:p><a:p><a:r><a:t>2. Reports</a:t></a:r></a:p></p:txBody></p:sp>';
    write(
      'ppt/slides/slide1.xml',
      read('ppt/slides/slide1.xml').replace('</p:spTree>', `${agenda}${TABLE_FRAME}</p:spTree>`)
    );
    // slide3 gets speaker notes.
    zip.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from(NOTES_XML, 'utf8'));
    write(
      'ppt/slides/_rels/slide3.xml.rels',
      read('ppt/slides/_rels/slide3.xml.rels').replace(
        '</Relationships>',
        '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
      )
    );
    deckPath = path.join(workDir, 'deck.pptx');
    zip.writeZip(deckPath);
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('returns slides in presentation order while slide_index keeps the file number', () => {
    const slides = extractPptxSlides(deckPath);
    expect(slides.map((slide) => slide.slide_index)).toEqual([3, 1, 2]);
    expect(slides.map((slide) => slide.position)).toEqual([1, 2, 3]);
    expect(slides[0].concatenated).toMatch(/Charlie/);
  });

  it('flags hidden slides', () => {
    const slides = extractPptxSlides(deckPath);
    expect(slides.find((slide) => slide.slide_index === 2)?.hidden).toBe(true);
    expect(slides.find((slide) => slide.slide_index === 1)?.hidden).toBe(false);
  });

  it('keeps paragraph breaks and extracts tables into rows and concatenated text', () => {
    const slide = extractPptxSlides(deckPath).find((s) => s.slide_index === 1)!;
    expect(slide.shapes_text).toContain('1. Resolutions\n2. Reports');
    expect(slide.tables).toEqual([
      [
        ['科目', '金額'],
        ['売上高', '41,593'],
      ],
    ]);
    expect(slide.concatenated).toContain('売上高\t41,593');
  });

  it('reads speaker notes from the body placeholder only', () => {
    const slides = extractPptxSlides(deckPath);
    expect(slides.find((slide) => slide.slide_index === 3)?.notes_text).toBe(
      'Speaker line one\nSpeaker line two'
    );
    expect(slides.find((slide) => slide.slide_index === 1)?.notes_text).toBe('');
  });

  it('accepts raw bytes and lists no image parts for text-only slides', () => {
    const fromBytes = extractPptxSlides(safeReadFile(deckPath, { encoding: null }) as Buffer);
    expect(fromBytes.map((slide) => slide.slide_index)).toEqual([3, 1, 2]);
    expect(fromBytes.every((slide) => slide.image_parts.length === 0)).toBe(true);
  });
});
