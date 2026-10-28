import { isRecord } from './foundation/text.js';

export interface AppleVisionLine {
  text: string;
  /** Vision candidate confidence on the OCR-wide 0..100 scale. */
  confidence: number;
  /** Normalized image fractions with a top-left origin. */
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface AppleVisionResult {
  text: string;
  labels: Array<{ label: string; confidence: number }>;
  /** Mean of native line confidences, on the OCR-wide 0..100 scale. */
  confidence?: number;
  /** Optional for compatibility with previously deployed bridge binaries. */
  lines?: AppleVisionLine[];
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeAppleVisionResult(value: unknown): AppleVisionResult | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.labels))
    return undefined;
  if (value.confidence !== undefined && !boundedNumber(value.confidence, 0, 100)) return undefined;
  let lines: AppleVisionLine[] | undefined;
  if (value.lines !== undefined) {
    if (!Array.isArray(value.lines)) return undefined;
    lines = [];
    for (const entry of value.lines) {
      if (
        !isRecord(entry) ||
        typeof entry.text !== 'string' ||
        !boundedNumber(entry.confidence, 0, 100) ||
        !isRecord(entry.boundingBox)
      )
        return undefined;
      const box = entry.boundingBox;
      if (
        !boundedNumber(box.x, 0, 1) ||
        !boundedNumber(box.y, 0, 1) ||
        !boundedNumber(box.width, 0, 1) ||
        !boundedNumber(box.height, 0, 1) ||
        box.width === 0 ||
        box.height === 0 ||
        box.x + box.width > 1 + 1e-6 ||
        box.y + box.height > 1 + 1e-6
      )
        return undefined;
      lines.push({
        text: entry.text,
        confidence: entry.confidence,
        boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      });
    }
  }
  if (lines && value.text !== lines.map((line) => line.text).join('\n')) return undefined;
  return {
    text: value.text,
    labels: value.labels.flatMap((entry) =>
      isRecord(entry) && typeof entry.label === 'string' && boundedNumber(entry.confidence, 0, 1)
        ? [{ label: entry.label, confidence: entry.confidence }]
        : []
    ),
    ...(typeof value.confidence === 'number' ? { confidence: value.confidence } : {}),
    ...(lines ? { lines } : {}),
  };
}
