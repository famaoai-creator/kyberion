import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from '../secure-io.js';
import { isRecord } from '../foundation/text.js';
import { OcrResult, OcrProvider } from '../ocr-types.js';

export function providerDataPolicy(provider: OcrProvider): NonNullable<OcrProvider['dataPolicy']> {
  if (provider.dataPolicy) return provider.dataPolicy;
  return provider.dataEgress === 'external' ? 'training_eligible' : 'local_only';
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

export function resolveOcrImagePath(requestPath: string): string {
  const resolvedPath = assertSafeRepositoryPath(pathResolver.rootResolve(requestPath), {
    allowMissingLeaf: true,
  });
  if (!safeLstat(resolvedPath).isFile()) {
    throw new Error(`[OCR_RESOURCE] input must be a regular file: ${requestPath}`);
  }
  return resolvedPath;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function finiteNumbers(record: Record<string, unknown>, keys: string[]): number[] | undefined {
  const values = keys.map((key) => record[key]);
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? (values as number[])
    : undefined;
}

/**
 * native-ocr.swift emits `boundingBox: {x, y, width, height}` as 0..1
 * fractions with a top-left origin; the legacy `bbox: {x0, y0, x1, y1}` corner
 * form is still accepted. Either way the result declares normalized units.
 */
export function parseAppleVisionLines(value: unknown): OcrResult['lines'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.text !== 'string') return [];
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : 0;
    let boundingBox: { x: number; y: number; width: number; height: number } | undefined;
    const box = isRecord(entry.boundingBox)
      ? finiteNumbers(entry.boundingBox, ['x', 'y', 'width', 'height'])
      : undefined;
    const corners = isRecord(entry.bbox)
      ? finiteNumbers(entry.bbox, ['x0', 'y0', 'x1', 'y1'])
      : undefined;
    if (box) {
      boundingBox = { x: box[0], y: box[1], width: box[2], height: box[3] };
    } else if (corners) {
      boundingBox = {
        x: corners[0],
        y: corners[1],
        width: corners[2] - corners[0],
        height: corners[3] - corners[1],
      };
    }
    return [{ text: entry.text, confidence, ...(boundingBox ? { boundingBox } : {}) }];
  });
}

export function parseGeminiOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = firstRecord(value.candidates);
  const content = candidate && isRecord(candidate.content) ? candidate.content : undefined;
  const part = content && firstRecord(content.parts);
  return part ? nonEmptyString(part.text) : undefined;
}

export function parseClaudeOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const content = firstRecord(value.content);
  return content ? nonEmptyString(content.text) : undefined;
}

export function parseOpenAiOcrResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const choice = firstRecord(value.choices);
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  return message ? nonEmptyString(message.content) : undefined;
}

export function parseLocalVlmOcrResponse(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.response) : undefined;
}

/** BCP-47 primary subtags → tesseract traineddata codes (3-letter codes pass through). */
const TESSERACT_LANGUAGE_CODES: Record<string, string> = {
  en: 'eng',
  ja: 'jpn',
  zh: 'chi_sim',
  ko: 'kor',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  it: 'ita',
  pt: 'por',
};

export function toTesseractLanguage(language?: string): string {
  const raw = String(language || '').trim();
  if (!raw) return 'eng';
  return raw
    .split('+')
    .map((part) => {
      const primary = part.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
      return TESSERACT_LANGUAGE_CODES[primary] ?? part.trim();
    })
    .join('+');
}
