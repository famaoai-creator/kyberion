import { resolveBorderKeySides } from '@agent/core';
import type { PdfDesignProtocol } from '@agent/core/media-contracts';
import * as mediaPdfHelpers from './media-pdf-helpers.js';

export interface PdfToPptxHints {
  canvas?: { fallbackW?: number; fallbackH?: number };
  features?: {
    fullPageImageOverlay?: boolean;
    fullPageImageOcrOverlay?: boolean;
  };
  ocr?: {
    language?: string;
  };
  style?: {
    fontFamily?: string;
    titleFontSize?: number;
    pageTitleFontSize?: number;
    bodyFontSize?: number;
    defaultTextColor?: string;
    bodyTextColor?: string;
  };
  layout?: {
    titlePos?: { x: number; y: number; w: number; h: number };
    pageTitlePos?: { x: number; y: number; w: number; h: number };
    bodyPos?: { x: number; y: number; w: number; h: number };
  };
  theme?: { dk1?: string; dk2?: string; lt1?: string; lt2?: string; accent1?: string; accent2?: string };
}

export interface PdfToXlsxHints {
  grid?: {
    clusterTolerance?: number;
    bgAreaThreshold?: number;
    rectMergeTolerance?: number;
    textCellTolerance?: number;
    borderSnapTolerance?: number;
    textLineTolerance?: number;
  };
  desk?: {
    columnsPerUnit?: number;
    smallGapRange?: [number, number];
    minSmallGapCount?: number;
    maxFillMergeExtraCols?: number;
  };
  columnWidths?: {
    breakpoints?: Array<{ maxPt: number; chars: number }>;
    defaultRatio?: number;
  };
  rowHeight?: {
    scaleFactor?: number;
    minimum?: number;
  };
  view?: {
    showGridLines?: boolean;
    zoomScale?: number;
  };
  pageSetup?: {
    orientation?: 'portrait' | 'landscape';
    paperSize?: number;
    scale?: number;
  };
  fonts?: {
    defaultName?: string;
    defaultSize?: number;
    defaultColor?: string;
  };
  theme?: {
    dk1?: string;
    lt1?: string;
    dk2?: string;
    lt2?: string;
    accent1?: string;
    accent2?: string;
  };
  alignment?: {
    horizontal?: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
    vertical?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed';
    wrapText?: boolean;
  };
  border?: {
    style?: 'thin' | 'medium' | 'thick' | 'double' | 'dotted' | 'dashed'
      | 'dashDot' | 'dashDotDot' | 'mediumDashed' | 'mediumDashDot'
      | 'mediumDashDotDot' | 'slantDashDot' | 'hair' | 'none';
    color?: string;
  };
  subMerge?: {
    minRowSpan?: number;
    textGapRows?: number;
  };
}

export const DEFAULT_PDF_TO_PPTX_HINTS: PdfToPptxHints = {
  canvas: { fallbackW: 10, fallbackH: 5.625 },
  features: {
    fullPageImageOverlay: false,
    fullPageImageOcrOverlay: false,
  },
  ocr: {
    language: 'jpn+eng',
  },
  style: {
    fontFamily: 'Aptos',
    titleFontSize: 28,
    pageTitleFontSize: 24,
    bodyFontSize: 16,
    defaultTextColor: '1F2937',
    bodyTextColor: '334155',
  },
  layout: {
    titlePos: { x: 0.7, y: 0.7, w: 8.8, h: 0.8 },
    pageTitlePos: { x: 0.7, y: 0.6, w: 8.8, h: 0.7 },
    bodyPos: { x: 0.8, y: 1.5, w: 8.4, h: 3.6 },
  },
  theme: {
    dk1: '111827',
    dk2: '475569',
    lt1: 'FFFFFF',
    lt2: 'F8FAFC',
    accent1: '2563EB',
    accent2: '0F172A',
  },
};

export const DEFAULT_PDF_TO_XLSX_HINTS: Required<PdfToXlsxHints> = {
  grid: {
    clusterTolerance: 3,
    bgAreaThreshold: 0.25,
    rectMergeTolerance: 3,
    textCellTolerance: 2,
    borderSnapTolerance: 2,
    textLineTolerance: 2,
  },
  desk: {
    columnsPerUnit: 3,
    smallGapRange: [5, 15],
    minSmallGapCount: 3,
    maxFillMergeExtraCols: 1,
  },
  columnWidths: {
    breakpoints: [
      { maxPt: 42, chars: 8 },
      { maxPt: 70, chars: 12 },
      { maxPt: 110, chars: 18 },
      { maxPt: 170, chars: 26 },
      { maxPt: 260, chars: 34 },
      { maxPt: Infinity, chars: 42 },
    ],
    defaultRatio: 6.5,
  },
  rowHeight: {
    scaleFactor: 0.85,
    minimum: 18,
  },
  view: {
    showGridLines: false,
    zoomScale: 85,
  },
  pageSetup: {
    orientation: 'landscape',
    paperSize: 9,
    scale: 100,
  },
  fonts: {
    defaultName: 'Aptos',
    defaultSize: 11,
    defaultColor: 'FF1F2937',
  },
  theme: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
  },
  alignment: {
    horizontal: 'center',
    vertical: 'center',
    wrapText: true,
  },
  border: {
    style: 'thin',
    color: '#000000',
  },
  subMerge: {
    minRowSpan: 4,
    textGapRows: 2,
  },
};

export function getXlsxColLetter(columnIndex: number): string {
  let value = Math.max(1, Math.floor(columnIndex));
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || 'A';
}

export function buildPptxProtocolFromPdfDesign(pdfDesign: PdfDesignProtocol, hints?: PdfToPptxHints): any {
  const resolvedHints: PdfToPptxHints = {
    canvas: { ...DEFAULT_PDF_TO_PPTX_HINTS.canvas, ...(hints?.canvas || {}) },
    features: { ...DEFAULT_PDF_TO_PPTX_HINTS.features, ...(hints?.features || {}) },
    ocr: { ...DEFAULT_PDF_TO_PPTX_HINTS.ocr, ...(hints?.ocr || {}) },
    style: { ...DEFAULT_PDF_TO_PPTX_HINTS.style, ...(hints?.style || {}) },
    layout: { ...DEFAULT_PDF_TO_PPTX_HINTS.layout, ...(hints?.layout || {}) },
    theme: { ...DEFAULT_PDF_TO_PPTX_HINTS.theme, ...(hints?.theme || {}) },
  };
  const title = pdfDesign.metadata?.title || pdfDesign.source?.title || 'PDF Conversion';
  const pageTexts = Array.isArray(pdfDesign.content?.pages) ? pdfDesign.content!.pages : [];
  const canvas = {
    w: Number(resolvedHints.canvas?.fallbackW || 10),
    h: Number(resolvedHints.canvas?.fallbackH || 5.625),
  };
  const summaryBullets = mediaPdfHelpers.chunkTextToBullets(
    pageTexts.map((page) => page.text || '').join('\n').trim() || pdfDesign.content?.text || '',
    4,
  );

  const slides = [
    {
      id: 'pdf-title',
      elements: [
        {
          type: 'text',
          placeholderType: 'title',
          pos: resolvedHints.layout?.titlePos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.titlePos!,
          text: title,
          style: {
            fontSize: resolvedHints.style?.titleFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.titleFontSize!,
            bold: true,
            color: resolvedHints.style?.defaultTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.defaultTextColor!,
            fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
            align: 'left',
          },
        },
        {
          type: 'text',
          placeholderType: 'body',
          pos: { x: 0.9, y: 1.9, w: 8.2, h: 2.8 },
          text: summaryBullets.length > 0 ? summaryBullets.map((item) => `• ${item}`).join('\n') : 'Converted from PDF design.',
          style: {
            fontSize: 18,
            color: resolvedHints.theme?.dk2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk2!,
            fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
            align: 'left',
          },
        },
      ],
    },
    ...pageTexts.map((page, index) => {
      const pageArea = (page?.width || 960) * (page?.height || 540);
      const positionedClipBlocks = mediaPdfHelpers.buildPositionedSlideClipBlocksFromPdfPage(page, canvas);
      const positionedElements = mediaPdfHelpers.buildPositionedSlideElementsFromPdfPage(page, canvas);
      const positionedImages = mediaPdfHelpers.buildPositionedSlideImagesFromPdfPage(page, canvas);
      const dominantBackgroundImage = resolvedHints.features?.fullPageImageOverlay
        ? (Array.isArray(page?.images) ? page.images.find((image: any) => (((image.width || 0) * (image.height || 0)) >= pageArea * 0.85)) : null)
        : null;
      const backgroundImageElement = dominantBackgroundImage
        ? {
            type: 'image',
            id: `pdf-page-bg-${index + 1}`,
            pos: { x: 0, y: 0, w: canvas.w, h: canvas.h },
            imagePath: dominantBackgroundImage.path,
          }
        : null;
      const overlayMode = Boolean(backgroundImageElement);
      const foregroundImages = dominantBackgroundImage
        ? positionedImages.filter((element: any) => element.imagePath !== dominantBackgroundImage.path)
        : positionedImages;
      const effectiveClipBlocks = overlayMode ? [] : positionedClipBlocks;
      const ocrOverlayElements = overlayMode ? mediaPdfHelpers.buildPositionedSlideOcrElementsFromPdfPage(page, canvas) : [];
      const effectiveElements = overlayMode
        ? (ocrOverlayElements.length > 0
            ? ocrOverlayElements
            : positionedElements
                .filter((element: any) => element.type === 'text')
                .filter((element: any) => (element.style?.bold || 0) || (element.style?.fontSize || 0) >= 18 || (element.text || '').length >= 24)
                .slice(0, 6))
        : positionedElements;
      const fallbackBullets = mediaPdfHelpers.isGridLikePdfPage(page)
        ? mediaPdfHelpers.buildGridPageSummary(page.text || '', 8)
        : mediaPdfHelpers.chunkTextToBullets(page.text || '', 8);
      return {
        id: `pdf-page-${index + 1}`,
        elements: effectiveElements.length > 0 || foregroundImages.length > 0 || Boolean(backgroundImageElement)
          ? [
              {
                type: 'text',
                placeholderType: 'title',
                pos: { x: 0.35, y: 0.25, w: 9.1, h: 0.45 },
                text: `Page ${page.pageNumber || index + 1}`,
                style: { fontSize: 14, bold: true, color: '64748B', fontFamily: 'Aptos', align: 'right' },
              },
              ...(backgroundImageElement ? [backgroundImageElement] : []),
              ...effectiveClipBlocks,
              ...foregroundImages,
              ...effectiveElements,
            ]
          : [
              {
                type: 'text',
                placeholderType: 'title',
                pos: resolvedHints.layout?.pageTitlePos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.pageTitlePos!,
                text: `Page ${page.pageNumber || index + 1}`,
                style: {
                  fontSize: resolvedHints.style?.pageTitleFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.pageTitleFontSize!,
                  bold: true,
                  color: resolvedHints.style?.defaultTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.defaultTextColor!,
                  fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
                  align: 'left',
                },
              },
              {
                type: 'text',
                placeholderType: 'body',
                pos: resolvedHints.layout?.bodyPos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.bodyPos!,
                text: fallbackBullets.join('\n') || '(No extractable page text)',
                style: {
                  fontSize: resolvedHints.style?.bodyFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.bodyFontSize!,
                  color: resolvedHints.style?.bodyTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.bodyTextColor!,
                  fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
                  align: 'left',
                },
              },
            ],
      };
    }),
  ];

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas,
    theme: {
      dk1: resolvedHints.theme?.dk1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk1!,
      dk2: resolvedHints.theme?.dk2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk2!,
      lt1: resolvedHints.theme?.lt1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.lt1!,
      lt2: resolvedHints.theme?.lt2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.lt2!,
      accent1: resolvedHints.theme?.accent1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.accent1!,
      accent2: resolvedHints.theme?.accent2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.accent2!,
    },
    master: {
      elements: [],
    },
    slides,
  };
}

export function buildXlsxProtocolFromPdfDesign(pdfDesign: PdfDesignProtocol, hints?: PdfToXlsxHints): any {
  const H = {
    grid: { ...DEFAULT_PDF_TO_XLSX_HINTS.grid, ...(hints?.grid || {}) },
    desk: { ...DEFAULT_PDF_TO_XLSX_HINTS.desk, ...(hints?.desk || {}) },
    columnWidths: {
      ...DEFAULT_PDF_TO_XLSX_HINTS.columnWidths,
      ...(hints?.columnWidths || {}),
      breakpoints: hints?.columnWidths?.breakpoints || DEFAULT_PDF_TO_XLSX_HINTS.columnWidths.breakpoints,
    },
    rowHeight: { ...DEFAULT_PDF_TO_XLSX_HINTS.rowHeight, ...(hints?.rowHeight || {}) },
    view: { ...DEFAULT_PDF_TO_XLSX_HINTS.view, ...(hints?.view || {}) },
    pageSetup: { ...DEFAULT_PDF_TO_XLSX_HINTS.pageSetup, ...(hints?.pageSetup || {}) },
    fonts: { ...DEFAULT_PDF_TO_XLSX_HINTS.fonts, ...(hints?.fonts || {}) },
    theme: { ...DEFAULT_PDF_TO_XLSX_HINTS.theme, ...(hints?.theme || {}) },
    alignment: { ...DEFAULT_PDF_TO_XLSX_HINTS.alignment, ...(hints?.alignment || {}) },
    border: { ...DEFAULT_PDF_TO_XLSX_HINTS.border, ...(hints?.border || {}) },
    subMerge: { ...DEFAULT_PDF_TO_XLSX_HINTS.subMerge, ...(hints?.subMerge || {}) },
  };

  const pages = Array.isArray(pdfDesign.content?.pages) ? pdfDesign.content.pages : [];
  const emptyProtocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name: 'PDF Import',
      colors: H.theme,
      majorFont: H.fonts.defaultName,
      minorFont: H.fonts.defaultName,
    },
    styles: {
      fonts: [],
      fills: [],
      borders: [],
      numFmts: [],
      cellXfs: [],
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: {} }],
      dxfs: [],
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    sheets: [],
  };
  if (pages.length === 0) return emptyProtocol;

  const clusterCoords = (values: number[], tolerance: number): number[] => {
    const sorted = [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    const clusters: number[] = [sorted[0]];
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] - clusters[clusters.length - 1] > tolerance) {
        clusters.push(sorted[index]);
      }
    }
    return clusters;
  };

  const snapToGrid = (value: number, bounds: number[]): number => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < bounds.length; index += 1) {
      const distance = Math.abs(bounds[index] - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  type StyleEntry = { fill?: string; fontSize?: number; fontColor?: string; borderKey?: string };
  const styleEntries: StyleEntry[] = [];
  const styleKeyToIndex = new Map<string, number>();
  const ensureCellStyle = (fill?: string, fontSize?: number, fontColor?: string, borderKey?: string): number => {
    const normalizedFill = fill ? fill.replace('#', '').toUpperCase() : '';
    const normalizedFontColor = fontColor ? fontColor.replace('#', '').toUpperCase() : '';
    const key = `${normalizedFill}|${fontSize || 0}|${normalizedFontColor}|${borderKey || ''}`;
    if (styleKeyToIndex.has(key)) return styleKeyToIndex.get(key)!;
    const index = styleEntries.length + 1;
    styleEntries.push({
      fill: normalizedFill || undefined,
      fontSize: fontSize || undefined,
      fontColor: normalizedFontColor || undefined,
      borderKey: borderKey || undefined,
    });
    styleKeyToIndex.set(key, index);
    return index;
  };

  const sheets = pages.map((page: any, pageIndex: number) => {
    const elements = Array.isArray(page?.elements) ? page.elements : [];
    const rects = elements.filter((element: any) => element.type === 'rect');
    const clips = elements.filter((element: any) => element.type === 'clip');
    const borders = elements.filter((element: any) => element.type === 'border');
    const texts = elements.filter((element: any) => (
      !['rect', 'line', 'ellipse', 'clip', 'border'].includes(element.type)
      && typeof element.text === 'string'
      && element.text.trim()
    ));

    const pageWidth = page?.width || 842;
    const pageHeight = page?.height || 595;
    const pageArea = pageWidth * pageHeight;

    const mergedRects: any[] = [];
    for (const rect of rects) {
      const existing = mergedRects.find((candidate: any) => (
        Math.abs(candidate.x - rect.x) < H.grid.rectMergeTolerance
        && Math.abs(candidate.y - rect.y) < H.grid.rectMergeTolerance
        && Math.abs(candidate.width - rect.width) < H.grid.rectMergeTolerance
        && Math.abs(candidate.height - rect.height) < H.grid.rectMergeTolerance
      ));
      if (existing) {
        if (rect.fillColor && !existing.fillColor) existing.fillColor = rect.fillColor;
        if (rect.strokeColor && !existing.strokeColor) existing.strokeColor = rect.strokeColor;
        continue;
      }
      mergedRects.push({ ...rect });
    }

    const cellRects = mergedRects.filter((rect: any) => ((rect.width || 0) * (rect.height || 0)) < pageArea * H.grid.bgAreaThreshold);
    const rawXValues: number[] = [];
    const rawYValues: number[] = [];

    borders.forEach((border: any) => {
      if ((border.width || 0) > (border.height || 0)) {
        rawYValues.push(Math.round(border.y || 0));
      } else {
        rawXValues.push(Math.round(border.x || 0));
      }
    });
    clips.forEach((clip: any) => {
      rawXValues.push(Math.round(clip.x || 0), Math.round((clip.x || 0) + (clip.width || 0)));
      rawYValues.push(Math.round(clip.y || 0), Math.round((clip.y || 0) + (clip.height || 0)));
    });
    cellRects.forEach((rect: any) => {
      rawXValues.push(Math.round(rect.x || 0), Math.round((rect.x || 0) + (rect.width || 0)));
      rawYValues.push(Math.round(rect.y || 0), Math.round((rect.y || 0) + (rect.height || 0)));
    });

    const baseYBounds = clusterCoords(rawYValues, H.grid.clusterTolerance);
    const sortedTexts = [...texts].sort((left: any, right: any) => (left.y || 0) - (right.y || 0));
    let lastAddedY = -Infinity;
    for (const text of sortedTexts) {
      const y = Math.round(text.y || 0);
      if (y - lastAddedY <= H.grid.clusterTolerance) continue;
      const above = baseYBounds.filter((bound) => bound <= y).pop();
      const below = baseYBounds.find((bound) => bound > y);
      if (above !== undefined && below !== undefined && y - above > H.grid.clusterTolerance && below - y > H.grid.clusterTolerance) {
        rawYValues.push(y);
      }
      lastAddedY = y;
    }

    let xBounds = clusterCoords(rawXValues, H.grid.clusterTolerance);
    const yBounds = clusterCoords(rawYValues, H.grid.clusterTolerance);

    if (xBounds.length > 5) {
      const xGaps = xBounds.slice(1).map((value, index) => value - xBounds[index]);
      const smallGaps = xGaps.filter((gap) => gap >= H.desk.smallGapRange[0] && gap <= H.desk.smallGapRange[1]);
      if (smallGaps.length >= H.desk.minSmallGapCount) {
        const medianSmall = [...smallGaps].sort((left, right) => left - right)[Math.floor(smallGaps.length / 2)];
        const extraBounds: number[] = [];
        for (let index = 0; index < xGaps.length; index += 1) {
          const gap = xGaps[index];
          if (gap >= medianSmall * 1.7 && gap <= medianSmall * 2.5) {
            extraBounds.push(Math.round(xBounds[index] + gap / 2));
          }
          if (gap >= medianSmall * 2.5 && gap <= medianSmall * 3.5) {
            extraBounds.push(Math.round(xBounds[index] + gap / 3));
            extraBounds.push(Math.round(xBounds[index] + (gap * 2) / 3));
          }
        }
        if (extraBounds.length > 0) {
          xBounds = clusterCoords([...rawXValues, ...extraBounds], H.grid.clusterTolerance);
        }
      }
    }

    if (xBounds.length < 2 || yBounds.length < 2) {
      const fallbackRows = texts.map((text: any, index: number) => ({
        index: index + 1,
        height: 18,
        customHeight: true,
        cells: [{
          ref: `A${index + 1}`,
          type: 'inlineStr',
          value: String(text.text || '').trim(),
          styleIndex: ensureCellStyle(undefined, text.fontSize, text.color, ''),
        }],
      }));
      return {
        id: `sheet${pageIndex + 1}`,
        name: `Page ${pageIndex + 1}`,
        state: 'visible',
        dimension: `A1:A${Math.max(1, fallbackRows.length)}`,
        sheetView: { showGridLines: H.view.showGridLines, zoomScale: H.view.zoomScale },
        pageSetup: { orientation: H.pageSetup.orientation, paperSize: H.pageSetup.paperSize, scale: H.pageSetup.scale },
        columns: [{ min: 1, max: 1, width: 42, customWidth: true }],
        rows: fallbackRows,
        mergeCells: [],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
      };
    }

    const columns = [];
    for (let index = 0; index < xBounds.length - 1; index += 1) {
      const widthPt = xBounds[index + 1] - xBounds[index];
      let widthChars = H.columnWidths.defaultRatio > 0
        ? Math.max(1.9, Number((widthPt / H.columnWidths.defaultRatio).toFixed(1)))
        : 2;
      for (const breakpoint of H.columnWidths.breakpoints) {
        if (widthPt <= breakpoint.maxPt) {
          widthChars = breakpoint.chars;
          break;
        }
      }
      columns.push({ min: index + 1, max: index + 1, width: widthChars, customWidth: true });
    }

    const numCols = xBounds.length - 1;
    const numRows = yBounds.length - 1;
    const occupied = Array.from({ length: numRows }, () => new Array(numCols).fill(false));
    const mergeCells: Array<{ ref: string }> = [];

    const xGapsForDesk = xBounds.slice(1).map((value, index) => value - xBounds[index]).filter((gap) => gap >= 5 && gap <= 15);
    const deskColCount = xGapsForDesk.length >= 3 ? H.desk.columnsPerUnit : 1;
    const maxMergeColsForFill = deskColCount + H.desk.maxFillMergeExtraCols;

    for (const rect of cellRects) {
      const isFillOnly = Boolean(rect.fillColor) && !cellRects.some((candidate: any) => (
        candidate !== rect
        && !candidate.fillColor
        && Math.abs((candidate.x || 0) - (rect.x || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.y || 0) - (rect.y || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.width || 0) - (rect.width || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.height || 0) - (rect.height || 0)) < H.grid.rectMergeTolerance
      ));
      const startCol = snapToGrid(Math.round(rect.x || 0), xBounds);
      const startRow = snapToGrid(Math.round(rect.y || 0), yBounds);
      const endCol = Math.min(snapToGrid(Math.round((rect.x || 0) + (rect.width || 0)), xBounds), numCols);
      const endRow = Math.min(snapToGrid(Math.round((rect.y || 0) + (rect.height || 0)), yBounds), numRows);
      if (startCol >= numCols || startRow >= numRows) continue;
      const spanCols = endCol - startCol;
      const spanRows = endRow - startRow;
      if (isFillOnly && spanCols > maxMergeColsForFill) continue;
      if (spanCols <= 1 && spanRows <= 1) continue;

      const subMergeRows: number[] = [startRow];
      if (spanRows > H.subMerge.minRowSpan) {
        const rectTexts = texts
          .filter((text: any) => {
            const x = text.x || 0;
            const y = text.y || 0;
            return x >= xBounds[startCol] - 5 && x < xBounds[endCol] + 5 && y >= yBounds[startRow] - 5 && y < yBounds[endRow] + 5;
          })
          .sort((left: any, right: any) => (left.y || 0) - (right.y || 0));
        let lastTextRow = startRow;
        for (const text of rectTexts) {
          const textRow = snapToGrid(Math.round(text.y || 0), yBounds);
          if (textRow > lastTextRow + H.subMerge.textGapRows && textRow > subMergeRows[subMergeRows.length - 1]) {
            subMergeRows.push(textRow);
          }
          lastTextRow = Math.max(lastTextRow, textRow);
        }
      }
      subMergeRows.push(endRow);

      for (let index = 0; index < subMergeRows.length - 1; index += 1) {
        const subStart = subMergeRows[index];
        const subEnd = subMergeRows[index + 1];
        if (subEnd <= subStart) continue;
        if (subEnd - subStart <= 1 && spanCols <= 1) continue;

        let canMerge = true;
        for (let row = subStart; row < subEnd && canMerge; row += 1) {
          for (let col = startCol; col < endCol && canMerge; col += 1) {
            if (occupied[row][col]) canMerge = false;
          }
        }
        if (!canMerge) continue;
        const startRef = `${getXlsxColLetter(startCol + 1)}${subStart + 1}`;
        const endRef = `${getXlsxColLetter(endCol)}${subEnd}`;
        mergeCells.push({ ref: `${startRef}:${endRef}` });
        for (let row = subStart; row < subEnd; row += 1) {
          for (let col = startCol; col < endCol; col += 1) {
            occupied[row][col] = true;
          }
        }
      }
    }

    const cellFillMap = new Map<string, string>();
    for (const rect of cellRects) {
      if (!rect.fillColor) continue;
      const startCol = snapToGrid(Math.round(rect.x || 0), xBounds);
      const startRow = snapToGrid(Math.round(rect.y || 0), yBounds);
      const endCol = Math.min(snapToGrid(Math.round((rect.x || 0) + (rect.width || 0)), xBounds), numCols);
      const endRow = Math.min(snapToGrid(Math.round((rect.y || 0) + (rect.height || 0)), yBounds), numRows);
      for (let row = startRow; row < endRow; row += 1) {
        for (let col = startCol; col < endCol; col += 1) {
          cellFillMap.set(`${row},${col}`, rect.fillColor);
        }
      }
    }

    type CellBorders = { top: boolean; bottom: boolean; left: boolean; right: boolean };
    const cellBorderMap = new Map<string, CellBorders>();
    const getCellBorders = (row: number, col: number): CellBorders => {
      const key = `${row},${col}`;
      if (!cellBorderMap.has(key)) {
        cellBorderMap.set(key, { top: false, bottom: false, left: false, right: false });
      }
      return cellBorderMap.get(key)!;
    };

    for (const border of borders) {
      if ((border.width || 0) > (border.height || 0)) {
        const borderY = Math.round(border.y || 0);
        const borderX1 = Math.round(border.x || 0);
        const borderX2 = Math.round((border.x || 0) + (border.width || 0));
        for (let row = 0; row < numRows; row += 1) {
          if (Math.abs(yBounds[row] - borderY) <= H.grid.borderSnapTolerance) {
            for (let col = 0; col < numCols; col += 1) {
              if (xBounds[col] >= borderX1 - H.grid.borderSnapTolerance && xBounds[col + 1] <= borderX2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).top = true;
                if (row > 0) getCellBorders(row - 1, col).bottom = true;
              }
            }
          }
          if (Math.abs(yBounds[row + 1] - borderY) <= H.grid.borderSnapTolerance) {
            for (let col = 0; col < numCols; col += 1) {
              if (xBounds[col] >= borderX1 - H.grid.borderSnapTolerance && xBounds[col + 1] <= borderX2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).bottom = true;
                if (row + 1 < numRows) getCellBorders(row + 1, col).top = true;
              }
            }
          }
        }
      } else {
        const borderX = Math.round(border.x || 0);
        const borderY1 = Math.round(border.y || 0);
        const borderY2 = Math.round((border.y || 0) + (border.height || 0));
        for (let col = 0; col < numCols; col += 1) {
          if (Math.abs(xBounds[col] - borderX) <= H.grid.borderSnapTolerance) {
            for (let row = 0; row < numRows; row += 1) {
              if (yBounds[row] >= borderY1 - H.grid.borderSnapTolerance && yBounds[row + 1] <= borderY2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).left = true;
                if (col > 0) getCellBorders(row, col - 1).right = true;
              }
            }
          }
          if (Math.abs(xBounds[col + 1] - borderX) <= H.grid.borderSnapTolerance) {
            for (let row = 0; row < numRows; row += 1) {
              if (yBounds[row] >= borderY1 - H.grid.borderSnapTolerance && yBounds[row + 1] <= borderY2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).right = true;
                if (col + 1 < numCols) getCellBorders(row, col + 1).left = true;
              }
            }
          }
        }
      }
    }

    const sheetRows: any[] = [];
    const usedTexts = new Set<number>();
    for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
      const rowY = yBounds[rowIndex];
      const rowHeight = yBounds[rowIndex + 1] - rowY;
      const cells: any[] = [];

      for (let colIndex = 0; colIndex < numCols; colIndex += 1) {
        const cellX = xBounds[colIndex];
        const cellWidth = xBounds[colIndex + 1] - cellX;
        const cellRef = `${getXlsxColLetter(colIndex + 1)}${rowIndex + 1}`;

        if (occupied[rowIndex][colIndex]) {
          const isMergeStart = mergeCells.some((merge) => merge.ref.startsWith(`${cellRef}:`));
          if (!isMergeStart) {
            cells.push({ ref: cellRef, styleIndex: 0 });
            continue;
          }
        }

        let searchEndX = cellX + cellWidth;
        let searchEndY = rowY + rowHeight;
        const merge = mergeCells.find((candidate) => candidate.ref.startsWith(`${cellRef}:`));
        if (merge) {
          const endParts = merge.ref.split(':')[1]?.match(/^([A-Z]+)(\d+)$/);
          if (endParts) {
            let endColNumber = 0;
            for (let index = 0; index < endParts[1].length; index += 1) {
              endColNumber = endColNumber * 26 + endParts[1].charCodeAt(index) - 64;
            }
            const endRowNumber = Number.parseInt(endParts[2], 10);
            if (endColNumber <= xBounds.length - 1) searchEndX = xBounds[endColNumber];
            if (endRowNumber <= yBounds.length - 1) searchEndY = yBounds[endRowNumber];
          }
        }

        const cellTexts = texts
          .map((text: any, textIndex: number) => ({ text, textIndex }))
          .filter(({ text, textIndex }) => {
            if (usedTexts.has(textIndex)) return false;
            return (text.x || 0) >= cellX - H.grid.textCellTolerance
              && (text.x || 0) < searchEndX + H.grid.textCellTolerance
              && (text.y || 0) >= rowY - H.grid.textCellTolerance
              && (text.y || 0) < searchEndY + H.grid.textCellTolerance;
          })
          .sort((left, right) => {
            const deltaY = (left.text.y || 0) - (right.text.y || 0);
            return Math.abs(deltaY) > 3 ? deltaY : (left.text.x || 0) - (right.text.x || 0);
          });

        let cellValue = '';
        let lastY = -Infinity;
        for (const { text } of cellTexts) {
          const y = text.y || 0;
          if (!cellValue) {
            cellValue = text.text || '';
          } else if (Math.abs(y - lastY) <= H.grid.textLineTolerance) {
            cellValue += ` ${text.text || ''}`;
          } else {
            cellValue += `\n${text.text || ''}`;
          }
          lastY = y;
        }
        cellValue = cellValue.trim();
        cellTexts.forEach(({ textIndex }) => usedTexts.add(textIndex));

        const dominantFontSize = cellTexts.map(({ text }) => text.fontSize).find((value) => Number.isFinite(value));
        const dominantFontColor = cellTexts.map(({ text }) => text.color).find((value) => typeof value === 'string');
        const fillColor = cellFillMap.get(`${rowIndex},${colIndex}`);
        const cellBorders = cellBorderMap.get(`${rowIndex},${colIndex}`);
        const borderKey = cellBorders
          ? `${cellBorders.top ? 'T' : ''}${cellBorders.bottom ? 'B' : ''}${cellBorders.left ? 'L' : ''}${cellBorders.right ? 'R' : ''}`
          : '';
        const hasStyle = fillColor || dominantFontSize || dominantFontColor || borderKey;
        const styleIndex = hasStyle ? ensureCellStyle(fillColor, dominantFontSize, dominantFontColor, borderKey) : 0;

        cells.push({
          ref: cellRef,
          value: cellValue || undefined,
          type: cellValue ? 'inlineStr' : undefined,
          styleIndex,
        });
      }

      sheetRows.push({
        index: rowIndex + 1,
        height: Math.max(H.rowHeight.minimum, Math.round(rowHeight * H.rowHeight.scaleFactor)),
        customHeight: true,
        cells,
      });
    }

    const lastColLetter = getXlsxColLetter(numCols);
    return {
      id: `sheet${pageIndex + 1}`,
      name: `Page ${pageIndex + 1}`,
      state: 'visible',
      dimension: `A1:${lastColLetter}${numRows}`,
      sheetView: { showGridLines: H.view.showGridLines, zoomScale: H.view.zoomScale },
      pageSetup: { orientation: H.pageSetup.orientation, paperSize: H.pageSetup.paperSize, scale: H.pageSetup.scale },
      columns,
      rows: sheetRows,
      mergeCells,
      tables: [],
      conditionalFormats: [],
      dataValidations: [],
    };
  });

  const defaultFont = { name: H.fonts.defaultName, size: H.fonts.defaultSize, color: { rgb: H.fonts.defaultColor } };
  const noBorder = {};
  const noFill = { patternType: 'none' as const };
  const grayFill = { patternType: 'gray125' as const };
  const thinSide = { style: H.border.style, color: { rgb: H.border.color } };

  const fonts: any[] = [defaultFont];
  const fills: any[] = [noFill, grayFill];
  const borders: any[] = [noBorder];
  const cellXfs: any[] = [{
    font: defaultFont,
    fill: noFill,
    border: noBorder,
    alignment: {
      horizontal: H.alignment.horizontal,
      vertical: H.alignment.vertical,
      wrapText: H.alignment.wrapText,
    },
  }];

  const fontCache = new Map<string, any>();
  fontCache.set(`${H.fonts.defaultSize}|${H.fonts.defaultColor.replace('#', '').toUpperCase()}`, defaultFont);
  const fillCache = new Map<string, any>();
  fillCache.set('', noFill);
  const borderCache = new Map<string, any>();
  borderCache.set('', noBorder);

  const resolveBorder = (key: string): any => {
    if (!key) return noBorder;
    if (borderCache.has(key)) return borderCache.get(key)!;
    const border: any = {};
    for (const side of resolveBorderKeySides(key)) {
      border[side] = thinSide;
    }
    borderCache.set(key, border);
    borders.push(border);
    return border;
  };

  for (const entry of styleEntries) {
    const fontKey = `${entry.fontSize || H.fonts.defaultSize}|${entry.fontColor || H.fonts.defaultColor.replace('#', '').toUpperCase()}`;
    let font = fontCache.get(fontKey);
    if (!font) {
      font = {
        name: H.fonts.defaultName,
        size: entry.fontSize || H.fonts.defaultSize,
        color: { rgb: entry.fontColor ? `#${entry.fontColor}` : H.fonts.defaultColor },
      };
      fontCache.set(fontKey, font);
      fonts.push(font);
    }

    const fillKey = entry.fill || '';
    let fill = fillCache.get(fillKey);
    if (!fill) {
      fill = { patternType: 'solid' as const, fgColor: { rgb: `#${entry.fill}` } };
      fillCache.set(fillKey, fill);
      fills.push(fill);
    }

    cellXfs.push({
      font,
      fill,
      border: resolveBorder(entry.borderKey || ''),
      alignment: {
        horizontal: H.alignment.horizontal,
        vertical: H.alignment.vertical,
        wrapText: H.alignment.wrapText,
      },
    });
  }

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name: 'PDF Import',
      colors: H.theme,
      majorFont: H.fonts.defaultName,
      minorFont: H.fonts.defaultName,
    },
    styles: {
      fonts,
      fills,
      borders,
      numFmts: [],
      cellXfs,
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: {} }],
      dxfs: [],
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    sheets,
  };
}
