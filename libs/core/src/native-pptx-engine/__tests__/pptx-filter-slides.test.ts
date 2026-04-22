/**
 * PPTX extractPptxSlides + filterPptxSlides — multi-owner template round-trip.
 *
 * Fixture is synthesized on the fly via generateNativePptx so the test is
 * self-contained and does not depend on any personal data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import {
  extractPptxSlides,
  filterPptxSlides,
  patchPptxText,
  patchPptxParagraphs,
  generateNativePptx,
} from '../engine.js';
import type { PptxDesignProtocol } from '../../types/pptx-protocol.js';

// Synthetic 5-slide deck: title + two sales slides + two report slides,
// each carrying an OWNER footer so we can test owner-based slide selection.
function createMultiOwnerProtocol(): PptxDesignProtocol {
  const OWNER_A = 'sales_owner';
  const OWNER_B = 'report_owner';
  const baseTheme = {
    dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
    accent1: '5B9BD5', accent2: 'ED7D31', accent3: 'A5A5A5',
    accent4: 'FFC000', accent5: '4472C4', accent6: '70AD47',
    hlink: '0563C1', folHlink: '954F72',
  };
  const headerText = (text: string) => ({
    type: 'text' as const,
    pos: { x: 1, y: 0.5, w: 8, h: 0.8 },
    text,
    style: { fontSize: 24, bold: true, color: '#000000' },
  });
  const footerText = (text: string) => ({
    type: 'text' as const,
    pos: { x: 1, y: 6.8, w: 8, h: 0.5 },
    text,
    style: { fontSize: 10, color: '#888888' },
  });
  const bodyText = (text: string) => ({
    type: 'text' as const,
    pos: { x: 1, y: 2, w: 8, h: 3 },
    text,
    style: { fontSize: 14, color: '#000000' },
  });

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 7.5 },
    theme: baseTheme,
    master: { elements: [] },
    slides: [
      {
        id: 'slide1.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          headerText('Cover'),
          bodyText('Monthly Report — Synthetic Fixture'),
        ],
      },
      {
        id: 'slide2.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          headerText('Financial Status'),
          bodyText('Status: on-track'),
          footerText(OWNER_A),
        ],
      },
      {
        id: 'slide3.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          headerText('Client Map'),
          bodyText('Clients: 19 active'),
          footerText(OWNER_A),
        ],
      },
      {
        id: 'slide4.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          headerText('Reorg Update'),
          bodyText('Target date: 4/1 planned'),
          footerText(OWNER_B),
        ],
      },
      {
        id: 'slide5.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          headerText('Outlook'),
          bodyText('Next quarter: expansion'),
          footerText(OWNER_B),
        ],
      },
    ],
  };
}

describe('PPTX extract + filter + patch — synthetic multi-owner fixture', () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-filter-test-'));
    fixturePath = path.join(tmpDir, 'multi-owner.pptx');
    await generateNativePptx(createMultiOwnerProtocol(), fixturePath);
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extractPptxSlides returns one entry per slide with text content', () => {
    const slides = extractPptxSlides(fixturePath);
    expect(slides).toHaveLength(5);
    expect(slides[0].concatenated).toMatch(/Cover/);
    expect(slides[1].concatenated).toMatch(/Financial Status/);
    expect(slides[1].concatenated).toMatch(/sales_owner/);
    expect(slides[3].concatenated).toMatch(/Reorg Update/);
    expect(slides[3].concatenated).toMatch(/report_owner/);
  });

  it('filterPptxSlides keeps only the selected slide', () => {
    const outPath = path.join(tmpDir, 'only-slide-4.pptx');
    filterPptxSlides(fixturePath, outPath, [4]);
    const slides = extractPptxSlides(outPath);
    expect(slides).toHaveLength(1);
    expect(slides[0].concatenated).toMatch(/Reorg Update/);
    expect(slides[0].concatenated).toMatch(/report_owner/);
  });

  it('filterPptxSlides preserves caller-specified order when reordering', () => {
    const outPath = path.join(tmpDir, 'reordered.pptx');
    filterPptxSlides(fixturePath, outPath, [5, 2]);
    const slides = extractPptxSlides(outPath);
    expect(slides).toHaveLength(2);
    expect(slides[0].concatenated).toMatch(/Outlook/);
    expect(slides[1].concatenated).toMatch(/Financial Status/);
  });

  it('full pipeline: filter + patch reaches expected final text', () => {
    const filteredPath = path.join(tmpDir, 'step1.pptx');
    const finalPath = path.join(tmpDir, 'step2.pptx');

    filterPptxSlides(fixturePath, filteredPath, [4]);

    // Replacements are keyed on observed <a:t> content so the test
    // is independent of the engine's run-splitting behavior.
    const observed = new Set(extractPptxSlides(filteredPath)[0].text_runs);
    const wanted: Record<string, string> = {
      'Target date: 4/1 planned': 'Target date: 4/1 completed',
      'report_owner': '',
    };
    const replacements = Object.fromEntries(
      Object.entries(wanted).filter(([k]) => observed.has(k)),
    );
    expect(Object.keys(replacements).length).toBeGreaterThan(0);

    patchPptxText(filteredPath, finalPath, replacements);

    const finalRuns = extractPptxSlides(finalPath)[0].text_runs;
    for (const [orig, repl] of Object.entries(replacements)) {
      expect(finalRuns).not.toContain(orig);
      if (repl !== '') expect(finalRuns).toContain(repl);
    }
  });

  it('patchPptxParagraphs replaces by concatenated-paragraph text (handles multi-run)', () => {
    const outPath = path.join(tmpDir, 'para-exact.pptx');
    const res = patchPptxParagraphs(fixturePath, outPath, [
      { original: 'Target date: 4/1 planned', replacement: 'Target date: 4/1 completed' },
    ]);
    expect(res.match_count).toBeGreaterThan(0);
    const text = extractPptxSlides(outPath)[3].concatenated;
    expect(text).toMatch(/Target date: 4\/1 completed/);
    expect(text).not.toMatch(/Target date: 4\/1 planned/);
  });

  it('patchPptxParagraphs contains-mode replaces a substring inside a paragraph', () => {
    const outPath = path.join(tmpDir, 'para-contains.pptx');
    const res = patchPptxParagraphs(fixturePath, outPath, [
      { original: 'planned', replacement: 'completed', mode: 'contains' },
    ]);
    expect(res.match_count).toBeGreaterThan(0);
    const text = extractPptxSlides(outPath)[3].concatenated;
    expect(text).toMatch(/Target date: 4\/1 completed/);
  });

  it('produced PPTX remains a valid OOXML package', () => {
    const outPath = path.join(tmpDir, 'validate.pptx');
    filterPptxSlides(fixturePath, outPath, [4]);

    const zip = new AdmZip(outPath);
    const entries = zip.getEntries().map(e => e.entryName);

    const slideFiles = entries.filter(n => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'));
    expect(slideFiles).toEqual(['ppt/slides/slide1.xml']);

    const ct = zip.readAsText('[Content_Types].xml');
    const slideOverrides = ct.match(/PartName="\/ppt\/slides\/slide\d+\.xml"/g) || [];
    expect(slideOverrides).toEqual(['PartName="/ppt/slides/slide1.xml"']);

    const presXml = zip.readAsText('ppt/presentation.xml');
    const sldIds = presXml.match(/<p:sldId[^/]*\/>/g) || [];
    expect(sldIds).toHaveLength(1);

    const ridMatch = sldIds[0].match(/r:id="(rId\d+)"/);
    expect(ridMatch).toBeTruthy();
    const relsXml = zip.readAsText('ppt/_rels/presentation.xml.rels');
    expect(relsXml).toMatch(new RegExp(`Id="${ridMatch![1]}"[^>]*Target="slides/slide1\\.xml"`));
  });
});
