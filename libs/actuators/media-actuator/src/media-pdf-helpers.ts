import type { PdfDesignProtocol } from '@agent/core/media-contracts';

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

export function isLikelyReliablePdfText(text: string): boolean {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 2) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;

  const meaningfulCount = Array.from(value).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  if (meaningfulCount < Math.max(2, Math.ceil(value.length * 0.35))) return false;

  const asciiLetters = Array.from(value).filter((char) => /[A-Za-z]/.test(char));
  if (asciiLetters.length >= 4 && !/\s/.test(value)) {
    const frequency = new Map<string, number>();
    for (const letter of asciiLetters) {
      frequency.set(letter, (frequency.get(letter) || 0) + 1);
    }
    const dominantLetterRatio = Math.max(...frequency.values()) / asciiLetters.length;
    if (dominantLetterRatio >= 0.5) return false;
  }

  return true;
}

export function mapOcrLineToPdfOverlay(page: any, line: any, index: number, fallbackConfidence: number): any | null {
  const text = String(line?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return null;
  const bbox = line?.bbox || {};
  const x0 = Number(bbox.x0 ?? 0);
  const y0 = Number(bbox.y0 ?? 0);
  const x1 = Number(bbox.x1 ?? x0);
  const y1 = Number(bbox.y1 ?? y0);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const confidence = Number(line?.confidence ?? fallbackConfidence ?? 0);
  if (confidence < 35) return null;
  return {
    id: `pdf-ocr-${page?.pageNumber || 0}-${index + 1}`,
    type: height >= 18 ? 'heading' : 'text',
    x: x0,
    y: y0,
    width,
    height,
    text,
    fontSize: Math.max(10, Math.round(height * 0.9)),
    confidence,
  };
}

export function buildPdfPageOcrOverlayLines(page: any, dominantImage: any, ocr: any): any[] {
  const ocrLines = Array.isArray(ocr?.data?.lines) ? ocr.data.lines : [];
  const fromLines = ocrLines
    .map((line: any, index: number) => mapOcrLineToPdfOverlay(page, line, index, ocr?.data?.confidence ?? 0))
    .filter(Boolean);
  if (fromLines.length > 0) return fromLines;

  const text = String(ocr?.data?.text || '').replace(/\r/g, '\n');
  const textLines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2);
  if (textLines.length === 0) return [];

  const baseX = Math.max(12, Number(dominantImage?.x ?? 0) + 18);
  const baseY = Math.max(12, Number(dominantImage?.y ?? 0) + 18);
  const maxWidth = Math.max(60, Math.min(Number(dominantImage?.width ?? page?.width ?? 960) - 36, (page?.width || 960) - baseX - 12));
  const lineHeight = 18;
  const maxLines = 18;
  const fallbackConfidence = Number(ocr?.data?.confidence ?? 0);
  return textLines.slice(0, maxLines).map((line, index) => ({
    id: `pdf-ocr-${page?.pageNumber || 0}-${index + 1}`,
    type: index === 0 && line.length <= 40 ? 'heading' : 'text',
    x: baseX,
    y: baseY + index * (lineHeight + 4),
    width: maxWidth,
    height: lineHeight,
    text: line,
    fontSize: index === 0 && line.length <= 40 ? 18 : 14,
    confidence: fallbackConfidence,
  }));
}

export function buildPositionedSlideOcrElementsFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const lines = Array.isArray(page?.ocrLines) ? page.ocrLines : [];
  return lines.slice(0, 8).map((line: any) => ({
    type: 'text',
    id: line.id,
    pos: {
      x: Number((((line.x || 0) / pageWidth) * canvas.w).toFixed(3)),
      y: Number((((line.y || 0) / pageHeight) * canvas.h).toFixed(3)),
      w: Number((Math.max(0.4, ((line.width || 0) / pageWidth) * canvas.w)).toFixed(3)),
      h: Number((Math.max(0.24, ((line.height || 0) / pageHeight) * canvas.h)).toFixed(3)),
    },
    text: line.text,
    style: {
      fontSize: Math.max(12, Math.min(24, Math.round(line.fontSize || 12))),
      bold: line.type === 'heading',
      color: line.type === 'heading' ? 'FFFFFF' : 'F8FAFC',
      fontFamily: 'Aptos',
      align: 'left',
      valign: 'top',
    },
  }));
}

export function chunkTextToBullets(input: string, maxItems = 5): string[] {
  return String(input || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\/(?:Span|P|Lbl|LBody|TT\d*|C\d+_\d+)\s*<<.*?>>BDC/gs, ' ')
    .replace(/\b(?:BDC|EMC|BT|ET|TJ|Tj|Tf|Td|Tm)\b/g, ' ')
    .replace(/<[\dA-Fa-f]{4,}>/g, ' ')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

export function splitCleanPdfTextIntoPages(input: string): Array<{ pageNumber: number; text: string }> {
  const lines = String(input || '').split(/\n/);
  const pages: Array<{ pageNumber: number; text: string }> = [];
  let currentPage = 1;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) {
      pages.push({ pageNumber: currentPage, text });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = line.match(/^--\s*(\d+)\s+of\s+\d+\s*--$/);
    if (marker) {
      flush();
      currentPage = Number(marker[1]) + 1;
      continue;
    }
    buffer.push(rawLine);
  }

  flush();
  return pages;
}

export function buildGridPageSummary(pageText: string, maxItems = 8): string[] {
  const rawLines = String(pageText || '')
    .split(/\n+/)
    .map((line) => line.replace(/\r/g, '').trim())
    .filter(Boolean);

  const skipExact = new Set([
    'カテゴリ',
    '選択肢',
    '回答方法',
    '質問文',
    'タイミング',
    '（1/2）',
    '（2/2）',
    '(参考)プログラム内容や運営への学び・改善点 各セッション メンティー向け',
    '(参考)プログラム内容や運営への学び・改善点 各セッション 人事担当者向け',
    '(参考)プログラム内容や運営への学び・改善点 全体 人事担当者向け',
  ]);

  const transientPattern = /^(?:\d+|✓|自由回答|1~[256]|1~5|\+|\/|Skill-?|input|Ment|oring|#\d+|キック|オフ後|クロー|ジン|グ後|タイミング|カテゴリ|選択肢|回答方法|質問文|後)$/;
  const continuationPattern = /^(?:どの|程度|ですか|すか|そう答えた理由|ください|ない|役立つ|感じた|感じなかった|自由回答|✓|1~[256]|1~5|\+|\/|次の|本日の|また、|（|大変満足|かなり達成)/;

  const mergedLines: string[] = [];
  for (const raw of rawLines) {
    const line = raw.replace(/\t+/g, '\t').replace(/[ ]{2,}/g, ' ').trim();
    if (!line) continue;

    const prev = mergedLines[mergedLines.length - 1];
    const isContinuation =
      prev &&
      (
        !prev.includes('。') &&
        !prev.includes('？') &&
        !prev.includes('?') &&
        (line.length <= 14 || continuationPattern.test(line))
      );

    if (isContinuation) {
      mergedLines[mergedLines.length - 1] = `${prev} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      mergedLines.push(line);
    }
  }

  const summaries: string[] = [];
  for (const raw of mergedLines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || skipExact.has(line)) continue;
    if (line.includes('G=G') || line.includes('FúFÔ')) continue;
    if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(line)) continue;
    if (transientPattern.test(line)) continue;

    const cols = raw
      .split('\t')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((part) => !skipExact.has(part))
      .filter((part) => !transientPattern.test(part));

    let summary = line;
    if (cols.length >= 2) {
      const question = cols.find((part) => /[。？?]|ですか|教えてください|ご記入ください|感じましたか|満足度/.test(part)) || cols[cols.length - 1];
      const option = cols.find((part) => /(?:1~[256]|1~5|自由回答|役立つ\/特に役立たない|感じた\/感じなかった|大変満足)/.test(part));
      const category = cols.find((part) => /(キックオフ|クロージング|メンタリング|スキルインプット|ラウンドテーブル|人事担当者|全体)/.test(part));
      summary = [category, question, option].filter(Boolean).join(' / ');
    }

    summary = summary
      .replace(/\s+\/\s+/g, ' / ')
      .replace(/\s+/g, ' ')
      .trim();

    if (summary.length < 12) continue;
    summaries.push(summary);
  }

  return Array.from(new Set(summaries)).slice(0, maxItems);
}

export function mergeCleanerPdfText(pdfDesign: PdfDesignProtocol, extractedText: string): PdfDesignProtocol {
  const cleanText = String(extractedText || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!cleanText) return pdfDesign;
  const cleanedPages = splitCleanPdfTextIntoPages(cleanText).map((page, index) => {
    const existing = pdfDesign.content?.pages?.[index];
    return {
      pageNumber: page.pageNumber,
      width: existing?.width || 595,
      height: existing?.height || 842,
      text: page.text,
      elements: existing?.elements,
      images: existing?.images,
      vectors: existing?.vectors,
      annotations: existing?.annotations,
      markedContent: existing?.markedContent,
      layerName: existing?.layerName,
    };
  });
  return {
    ...pdfDesign,
    source: {
      ...pdfDesign.source,
      body: cleanText,
    },
    content: pdfDesign.content
      ? {
          ...pdfDesign.content,
          text: cleanText,
          pages: cleanedPages.length > 0 ? cleanedPages : pdfDesign.content.pages,
        }
      : {
          text: cleanText,
          pages: cleanedPages,
        },
  };
}

export async function extractCleanerPdfText(pdfPath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const { safeReadFile } = await import('@agent/core');
  const data = safeReadFile(pdfPath, { encoding: null }) as Buffer;
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return String(result.text || '');
  } finally {
    await parser.destroy();
  }
}

export function isRenderablePdfElementText(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = normalizePdfElementText(text);
  if (!normalized) return false;
  if (/[\u0000-\u001F]/.test(normalized)) return false;
  if (looksLikeGarbledAscii(normalized)) return false;
  let weirdCount = 0;
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x80 && code <= 0x9f) || code === 0xfffd) weirdCount++;
  }
  return weirdCount / normalized.length < 0.15;
}

export function looksLikeGarbledAscii(text: string): boolean {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  if (/\s/.test(text)) return false;
  if (text.length < 5) return false;
  if (/(?:G.{0,2}){3,}/.test(text)) return true;
  if (/F[þûôóï]/.test(text)) return true;
  return false;
}

export function normalizePdfElementText(text: string | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => {
      const value = parseInt(octal, 8);
      if (value === 0x95) return '•';
      if (value === 0x96) return '–';
      if (value === 0x97) return '—';
      return String.fromCharCode(value);
    })
    .replace(/[\uF09F\u2022\u2023\u25E6\u2043]/g, '•')
    .replace(/[‒–—]/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

export function finalizePdfLineText(parts: string[]): string {
  const repeatableOnce = new Set(['✓', '自由回答', '+', '/', '1~6', '1~5', '1~2', '後']);
  const tokens: string[] = [];
  const seenRepeatable = new Set<string>();
  for (const raw of parts) {
    const token = normalizePdfElementText(raw);
    if (!token) continue;
    if (tokens[tokens.length - 1] === token) continue;
    if (repeatableOnce.has(token)) {
      if (seenRepeatable.has(token)) continue;
      seenRepeatable.add(token);
    }
    tokens.push(token);
  }

  return tokens
    .join(' ')
    .replace(/\s+([,.;:、。])/g, '$1')
    .replace(/•\s+/g, '• ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isRenderablePdfLineText(text: string): boolean {
  if (!text) return false;
  if (looksLikeGarbledAscii(text)) return false;
  if (/[F][þûôóï]/.test(text)) return false;
  if (/G[=;Q9T][A-Za-z0-9ŠVGx]+/.test(text)) return false;
  const japaneseCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const symbolCount = (text.match(/[✓•+\/]/g) || []).length;
  if (japaneseCount === 0 && symbolCount >= 3) return false;
  return true;
}

export function buildRenderablePdfLines(page: any) {
  const pageElements = Array.isArray(page?.elements) ? page.elements : [];
  const sorted = pageElements
    .filter((element: any) => (element.type === 'text' || element.type === 'heading') && isRenderablePdfElementText(element.text))
    .map((element: any) => ({
      ...element,
      text: normalizePdfElementText(element.text),
    }))
    .filter((element: any) => element.text)
    .sort((a: any, b: any) => (a.y - b.y) || (a.x - b.x));

  const lines: any[] = [];
  for (const element of sorted) {
    const previous = lines[lines.length - 1];
    const tolerance = Math.max(4, (element.fontSize || 12) * 0.45);
    if (!previous || Math.abs(previous.y - element.y) > tolerance) {
      lines.push({
        y: element.y,
        x: element.x,
        width: element.width || 0,
        height: element.height || 0,
        fontSize: element.fontSize || 12,
        type: element.type,
        parts: [element],
      });
      continue;
    }

    previous.parts.push(element);
    previous.y = Math.min(previous.y, element.y);
    previous.x = Math.min(previous.x, element.x);
    previous.width = Math.max(previous.width, (element.x + (element.width || 0)) - previous.x);
    previous.height = Math.max(previous.height, element.height || 0);
    previous.fontSize = Math.max(previous.fontSize, element.fontSize || 12);
    if (element.type === 'heading') previous.type = 'heading';
  }

  return lines
    .map((line) => {
      const text = finalizePdfLineText(
        line.parts
        .sort((a: any, b: any) => a.x - b.x)
        .map((part: any) => part.text),
      );
      return { ...line, text };
    })
    .filter((line) => line.text && line.text.length >= 2)
    .filter((line) => isRenderablePdfLineText(line.text))
    .filter((line) => {
      const normalized = line.text.replace(/\s+/g, '');
      return !/^[0-9]+$/.test(normalized) || line.type === 'heading';
    });
}

export function isGridLikePdfPage(page: any): boolean {
  const pageElements = Array.isArray(page?.elements) ? page.elements : [];
  if (pageElements.length < 60) return false;

  const xBuckets = new Set(pageElements.map((element: any) => Math.round((element.x || 0) / 20)));
  const undefinedFontCount = pageElements.filter((element: any) => !element.fontName).length;
  const shortCount = pageElements.filter((element: any) => normalizePdfElementText(element.text).length <= 4).length;
  const shortRatio = pageElements.length > 0 ? shortCount / pageElements.length : 0;
  const undefinedFontRatio = pageElements.length > 0 ? undefinedFontCount / pageElements.length : 0;

  return xBuckets.size >= 18 && (shortRatio > 0.35 || undefinedFontRatio > 0.2);
}

function getPdfPageClips(page: any) {
  return Array.isArray(page?.elements)
    ? page.elements.filter((element: any) => element?.type === 'clip' && (element.width || 0) > 8 && (element.height || 0) > 8)
    : [];
}

function intersectsPdfRegion(
  left: number,
  top: number,
  width: number,
  height: number,
  region: { x?: number; y?: number; width?: number; height?: number },
): boolean {
  const right = left + width;
  const bottom = top + height;
  const regionLeft = region.x || 0;
  const regionTop = region.y || 0;
  const regionRight = regionLeft + (region.width || 0);
  const regionBottom = regionTop + (region.height || 0);
  return Math.min(right, regionRight) > Math.max(left, regionLeft)
    && Math.min(bottom, regionBottom) > Math.max(top, regionTop);
}

export function buildPositionedSlideClipBlocksFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const clips = getPdfPageClips(page);
  const rects = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'rect') : [];
  const borders = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'border') : [];
  const pageArea = pageWidth * pageHeight;

  return clips
    .filter((clip: any) => ((clip.width || 0) * (clip.height || 0)) < pageArea * 0.92)
    .map((clip: any, index: number) => {
      let bestRect: any = null;
      let bestArea = 0;
      for (const rect of rects) {
        const overlapLeft = Math.max(clip.x || 0, rect.x || 0);
        const overlapTop = Math.max(clip.y || 0, rect.y || 0);
        const overlapRight = Math.min((clip.x || 0) + (clip.width || 0), (rect.x || 0) + (rect.width || 0));
        const overlapBottom = Math.min((clip.y || 0) + (clip.height || 0), (rect.y || 0) + (rect.height || 0));
        const overlapWidth = overlapRight - overlapLeft;
        const overlapHeight = overlapBottom - overlapTop;
        if (overlapWidth <= 0 || overlapHeight <= 0) continue;
        const overlapArea = overlapWidth * overlapHeight;
        if (overlapArea > bestArea) {
          bestArea = overlapArea;
          bestRect = rect;
        }
      }
      let bestBorder: any = null;
      let bestBorderScore = -1;
      for (const border of borders) {
        const horizontal = (border.width || 0) >= (border.height || 0);
        const borderLeft = border.x || 0;
        const borderTop = border.y || 0;
        const borderRight = borderLeft + (border.width || 0);
        const borderBottom = borderTop + (border.height || 0);
        const clipLeft = clip.x || 0;
        const clipTop = clip.y || 0;
        const clipRight = clipLeft + (clip.width || 0);
        const clipBottom = clipTop + (clip.height || 0);
        const nearTop = horizontal && Math.abs(borderTop - clipTop) <= 2 && borderRight > clipLeft && borderLeft < clipRight;
        const nearBottom = horizontal && Math.abs(borderTop - clipBottom) <= 2 && borderRight > clipLeft && borderLeft < clipRight;
        const nearLeft = !horizontal && Math.abs(borderLeft - clipLeft) <= 2 && borderBottom > clipTop && borderTop < clipBottom;
        const nearRight = !horizontal && Math.abs(borderLeft - clipRight) <= 2 && borderBottom > clipTop && borderTop < clipBottom;
        if (!(nearTop || nearBottom || nearLeft || nearRight)) continue;
        const score = Math.max(border.width || 0, border.height || 0);
        if (score > bestBorderScore) {
          bestBorderScore = score;
          bestBorder = border;
        }
      }
      return {
        type: 'shape',
        id: `pdf-clip-${page.pageNumber || 0}-${index + 1}`,
        shapeType: 'rect',
        pos: {
          x: Number((((clip.x || 0) / pageWidth) * canvas.w).toFixed(3)),
          y: Number((((clip.y || 0) / pageHeight) * canvas.h).toFixed(3)),
          w: Number((Math.max(0.2, ((clip.width || 0) / pageWidth) * canvas.w)).toFixed(3)),
          h: Number((Math.max(0.2, ((clip.height || 0) / pageHeight) * canvas.h)).toFixed(3)),
        },
        style: {
          fill: (bestRect?.fillColor || 'F8FAFC').replace('#', ''),
          line: (bestBorder?.strokeColor || bestRect?.strokeColor || 'E2E8F0').replace('#', ''),
          lineWidth: bestBorder?.lineWidth || bestRect?.lineWidth || 1,
          opacity: bestRect?.opacity !== undefined ? Math.max(1, Math.min(100, Math.round(bestRect.opacity * 100))) : 16,
        },
      };
    });
}

export function buildPositionedSlideElementsFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  if (Array.isArray(page?.elements) && page.elements.length >= 60) {
    const xBuckets = new Set(page.elements.map((element: any) => Math.round((element.x || 0) / 20)));
    const undefinedFontCount = page.elements.filter((element: any) => !element.fontName).length;
    const shortCount = page.elements.filter((element: any) => normalizePdfElementText(element.text).length <= 4).length;
    const shortRatio = page.elements.length > 0 ? shortCount / page.elements.length : 0;
    const undefinedFontRatio = page.elements.length > 0 ? undefinedFontCount / page.elements.length : 0;
    if (xBuckets.size >= 18 && (shortRatio > 0.35 || undefinedFontRatio > 0.2)) return [];
  }
  const clips = getPdfPageClips(page);
  const filteredPage = clips.length === 0 ? page : {
    ...page,
    elements: (Array.isArray(page?.elements) ? page.elements : []).filter((element: any) => (
      !['text', 'heading'].includes(element?.type)
      || clips.some((clip: any) => intersectsPdfRegion(element.x || 0, element.y || 0, element.width || 0, element.height || 0, clip))
    )),
  };
  const lines = buildRenderablePdfLines(filteredPage);
  const noisyPage = lines.length > 0 && lines.filter((line) => line.text.length < 6).length / lines.length > 0.45;
  if (noisyPage) return [];

  return lines
    .slice(0, 12)
    .map((line: any, index: number) => {
      const x = Number(((line.x / pageWidth) * canvas.w).toFixed(3));
      const y = Number(((line.y / pageHeight) * canvas.h).toFixed(3));
      const w = Number((Math.min(canvas.w - x - 0.2, Math.max(1.6, (line.width / pageWidth) * canvas.w))).toFixed(3));
      const h = Number((Math.max(0.32, (line.height / pageHeight) * canvas.h)).toFixed(3));
      const fontSize = Math.max(12, Math.min(24, Math.round((line.fontSize || 12) * 1.18)));
      return {
        type: 'text',
        id: `pdf-line-${page.pageNumber || 0}-${index + 1}`,
        pos: { x, y, w, h },
        text: line.text,
        style: {
          fontSize,
          bold: line.type === 'heading' || fontSize >= 18,
          color: line.type === 'heading' ? '1F2937' : '334155',
          fontFamily: 'Aptos',
          align: 'left',
          valign: 'top',
        },
      };
    });
}

export function buildPositionedSlideImagesFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const images = Array.isArray(page?.images) ? page.images : [];
  const clips = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'clip') : [];

  const findBestClip = (image: any) => {
    const imageLeft = image.x || 0;
    const imageTop = image.y || 0;
    const imageRight = imageLeft + (image.width || 0);
    const imageBottom = imageTop + (image.height || 0);
    let bestClip: any = null;
    let bestArea = 0;
    for (const clip of clips) {
      const clipLeft = clip.x || 0;
      const clipTop = clip.y || 0;
      const clipRight = clipLeft + (clip.width || 0);
      const clipBottom = clipTop + (clip.height || 0);
      const overlapLeft = Math.max(imageLeft, clipLeft);
      const overlapTop = Math.max(imageTop, clipTop);
      const overlapRight = Math.min(imageRight, clipRight);
      const overlapBottom = Math.min(imageBottom, clipBottom);
      const overlapWidth = overlapRight - overlapLeft;
      const overlapHeight = overlapBottom - overlapTop;
      if (overlapWidth <= 0 || overlapHeight <= 0) continue;
      const overlapArea = overlapWidth * overlapHeight;
      if (overlapArea > bestArea) {
        bestArea = overlapArea;
        bestClip = {
          x: overlapLeft,
          y: overlapTop,
          width: overlapWidth,
          height: overlapHeight,
        };
      }
    }
    return bestClip;
  };

  return images
    .filter((image: any) => typeof image?.path === 'string' && image.path)
    .map((image: any, index: number) => {
      const clip = findBestClip(image);
      const visible = clip || image;
      const x = Number((((visible.x || 0) / pageWidth) * canvas.w).toFixed(3));
      const y = Number((((visible.y || 0) / pageHeight) * canvas.h).toFixed(3));
      const w = Number((Math.max(0.3, ((visible.width || 0) / pageWidth) * canvas.w)).toFixed(3));
      const h = Number((Math.max(0.3, ((visible.height || 0) / pageHeight) * canvas.h)).toFixed(3));
      const result: any = {
        type: 'image',
        id: `pdf-image-${page.pageNumber || 0}-${index + 1}`,
        pos: { x, y, w, h },
        imagePath: image.path,
      };
      if (clip) {
        const baseWidth = Math.max(1, image.width || 0);
        const baseHeight = Math.max(1, image.height || 0);
        result.crop = {
          left: Math.round((((clip.x - (image.x || 0)) / baseWidth) * 100000)),
          top: Math.round((((clip.y - (image.y || 0)) / baseHeight) * 100000)),
          right: Math.round(((((image.x || 0) + baseWidth - (clip.x + clip.width)) / baseWidth) * 100000)),
          bottom: Math.round(((((image.y || 0) + baseHeight - (clip.y + clip.height)) / baseHeight) * 100000)),
        };
      }
      return result;
    });
}
