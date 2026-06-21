import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateNativePptx, generateNativeXlsx, pathResolver, safeExistsSync, safeMkdir, safeRmSync } from '@agent/core';
import type { PptxDesignProtocol, XlsxDesignProtocol } from '@agent/core/media-contracts';
import { extract } from './extraction-engine.js';

function createTestPptxProtocol(): PptxDesignProtocol {
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 7.5 },
    theme: {
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
    },
    master: { elements: [] },
    slides: [
      {
        id: 'slide1.xml',
        elements: [
          {
            type: 'text',
            pos: { x: 1, y: 1, w: 8, h: 1 },
            text: 'Raw preservation test',
            style: { fontSize: 24, bold: true, align: 'center' },
          },
        ],
      },
    ],
  };
}

function createTestXlsxProtocol(): XlsxDesignProtocol {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      colors: {
        dk1: '000000',
        lt1: 'FFFFFF',
        dk2: '1F2937',
        lt2: 'E5E7EB',
        accent1: '1E3A5F',
        accent2: '10B981',
        accent3: '3B82F6',
        accent4: 'F59E0B',
        accent5: '8B5CF6',
        accent6: 'EF4444',
        hlink: '2563EB',
        folHlink: '7C3AED',
      },
    },
    styles: {
      fonts: [
        { name: 'Yu Gothic', size: 11, scheme: 'minor' as const },
        { name: 'Yu Gothic', size: 11, bold: true, color: { rgb: '#FFFFFF' } },
      ],
      fills: [
        { patternType: 'none' as const },
        { patternType: 'gray125' as const },
        { patternType: 'solid' as const, fgColor: { rgb: '#1E3A5F' } },
      ],
      borders: [{}],
      numFmts: [],
      cellXfs: [
        { font: { name: 'Yu Gothic', size: 11, scheme: 'minor' as const }, fill: { patternType: 'none' as const }, border: {} },
        { font: { name: 'Yu Gothic', size: 11, bold: true, color: { rgb: '#FFFFFF' } }, fill: { patternType: 'solid' as const, fgColor: { rgb: '#1E3A5F' } }, border: {} },
      ],
      dxfs: [],
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: { font: { name: 'Yu Gothic', size: 11, scheme: 'minor' as const }, fill: { patternType: 'none' as const }, border: {} } }],
    },
    sharedStrings: [],
    definedNames: [],
    sheets: [
      {
        id: 'sheet1',
        name: 'Sheet1',
        state: 'visible',
        dimension: 'A1:B2',
        columns: [],
        rows: [
          {
            index: 1,
            cells: [
              { ref: 'A1', type: 's', value: 'Header', styleIndex: 1 },
              { ref: 'B1', type: 's', value: 'Value', styleIndex: 1 },
            ],
          },
          {
            index: 2,
            cells: [
              { ref: 'A2', type: 's', value: 'Row', styleIndex: 0 },
              { ref: 'B2', type: 'n', value: 1, styleIndex: 0 },
            ],
          },
        ],
        mergeCells: [],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
      },
    ],
  };
}

describe('artisan extraction engine raw preservation', () => {
  const tmpRoot = pathResolver.sharedTmp('actuators/media-actuator/raw-extract-tests');
  const pptxPath = path.join(tmpRoot, 'sample.pptx');
  const xlsxPath = path.join(tmpRoot, 'sample.xlsx');

  beforeAll(async () => {
    safeMkdir(tmpRoot, { recursive: true });
    await generateNativePptx(createTestPptxProtocol(), pptxPath);
    await generateNativeXlsx(createTestXlsxProtocol(), xlsxPath);
  });

  afterAll(() => {
    if (safeExistsSync(pptxPath)) safeRmSync(pptxPath, { force: true });
    if (safeExistsSync(xlsxPath)) safeRmSync(xlsxPath, { force: true });
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps the default extraction output lean', async () => {
    const pptx = await extract(pptxPath);
    const xlsx = await extract(xlsxPath);

    expect(pptx.layers.raw).toBeUndefined();
    expect(xlsx.layers.raw).toBeUndefined();
    expect(pptx.layers.content).toContain('Raw preservation test');
    expect(xlsx.layers.content).toContain('Header');
  });

  it('adds a raw preservation layer when requested', async () => {
    const pptx = await extract(pptxPath, 'all', { preserveRaw: true });
    const xlsx = await extract(xlsxPath, 'all', { preserveRaw: true });

    expect(pptx.layers.raw).toEqual(expect.objectContaining({
      version: '3.0.0',
      slides: expect.any(Array),
      rawThemeXml: expect.any(String),
    }));
    expect(pptx.layers.raw.slides[0]).toEqual(expect.objectContaining({
      rawSlideXml: expect.any(String),
    }));
    expect(xlsx.layers.raw).toEqual(expect.objectContaining({
      version: '1.0.0',
      sheets: expect.any(Array),
      styles: expect.objectContaining({
        rawStylesXml: expect.any(String),
      }),
    }));
  });
});
