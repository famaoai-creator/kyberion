import type { OcrResult } from './ocr-types.js';
import { findPiiSpans } from './pii-scrubber.js';

export interface RgbaFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface RedactionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  reason: 'pii' | 'known_sensitive_value' | 'high_entropy_shape';
}

export interface FrameRedactionResult {
  status: 'redacted' | 'withheld';
  frame?: RgbaFrame;
  regions: RedactionRegion[];
  finding_count: number;
  reason?: string;
}

function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}

function looksLikeSecretShape(value: string): boolean {
  const normalized = value.replace(/\s/g, '');
  return (
    normalized.length >= 20 &&
    entropy(normalized) >= 3.2 &&
    /[a-z]/i.test(normalized) &&
    /\d/.test(normalized) &&
    (normalized.match(/[a-z0-9]/gi) || []).length / normalized.length >= 0.75
  );
}

function fillOpaque(frame: RgbaFrame, region: RedactionRegion): void {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(frame.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(frame.height, Math.ceil(region.y + region.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * frame.width + x) * 4;
      frame.pixels[offset] = 0;
      frame.pixels[offset + 1] = 0;
      frame.pixels[offset + 2] = 0;
      frame.pixels[offset + 3] = 255;
    }
  }
}

function mergeRegion(regions: RedactionRegion[], next: RedactionRegion): void {
  if (
    !regions.some(
      (region) =>
        region.x === next.x &&
        region.y === next.y &&
        region.width === next.width &&
        region.height === next.height
    )
  )
    regions.push(next);
}

/**
 * Redact a frame using OCR only as a coordinate source. OCR text and raw
 * values are not returned. A failed OCR result withholds the frame.
 */
export function redactFrame(input: {
  frame: RgbaFrame;
  ocr: OcrResult | null;
  knownSensitiveText?: string[];
}): FrameRedactionResult {
  if (!input.ocr || input.ocr.status !== 'succeeded' || !Array.isArray(input.ocr.lines))
    return {
      status: 'withheld',
      regions: [],
      finding_count: 0,
      reason: input.ocr?.error || 'ocr_unavailable',
    };
  const frame: RgbaFrame = {
    width: input.frame.width,
    height: input.frame.height,
    pixels: new Uint8Array(input.frame.pixels),
  };
  const regions: RedactionRegion[] = [];
  let findingCount = 0;
  // A literal captured outside OCR is authoritative. Prefer the OCR box when
  // it contains the literal; if OCR cannot locate it, redact the whole frame
  // rather than guessing a smaller rectangle.
  const knownValues = (input.knownSensitiveText || []).filter((value) => value.length > 0);
  for (const value of knownValues) {
    const matchingLine = input.ocr.lines.find((line) => line.text.includes(value));
    if (matchingLine?.boundingBox) {
      mergeRegion(regions, { ...matchingLine.boundingBox, reason: 'known_sensitive_value' });
      findingCount += 1;
    } else {
      const region: RedactionRegion = {
        x: 0,
        y: 0,
        width: input.frame.width,
        height: input.frame.height,
        reason: 'known_sensitive_value',
      };
      regions.push(region);
      fillOpaque(frame, region);
      return { status: 'redacted', frame, regions, finding_count: findingCount + 1 };
    }
  }
  for (const line of input.ocr.lines) {
    const spans = findPiiSpans(line.text);
    const hasShape = looksLikeSecretShape(line.text);
    if (spans.length === 0 && !hasShape) continue;
    // A finding without coordinates cannot be safely redacted. Sending the
    // original frame would turn an OCR limitation into an exfiltration path.
    if (!line.boundingBox) {
      return {
        status: 'withheld',
        regions,
        finding_count: findingCount + Math.max(1, spans.length),
        reason: 'pii_coordinates_unavailable',
      };
    }
    const reason = hasShape ? 'high_entropy_shape' : 'pii';
    mergeRegion(regions, { ...line.boundingBox, reason });
    findingCount += Math.max(1, spans.length);
  }
  for (const region of regions) fillOpaque(frame, region);
  return { status: 'redacted', frame, regions, finding_count: findingCount };
}

export interface DistillationEgressPayload {
  text: string;
  frame?: RgbaFrame;
  ocr?: OcrResult | null;
  known_sensitive_text?: string[];
}
export interface DistillationEgressResult {
  status: 'ready' | 'withheld';
  text?: string;
  frame?: RgbaFrame;
  redaction?: FrameRedactionResult;
  reason?: string;
}

/** Single egress gate: no backend receives a payload before this returns ready. */
export function prepareDistillationEgress(
  payload: DistillationEgressPayload
): DistillationEgressResult {
  try {
    const textSpans = findPiiSpans(payload.text);
    if (textSpans.some((span) => span.action === 'block' || span.severity === 'secret'))
      return { status: 'withheld', reason: 'text_secret_detected' };
    const knownValues = (payload.known_sensitive_text || []).filter((value) => value.length > 0);
    if (knownValues.some((value) => payload.text.includes(value)))
      return { status: 'withheld', reason: 'known_sensitive_text_detected' };
    if (!payload.frame) return { status: 'ready', text: payload.text };
    const redaction = redactFrame({
      frame: payload.frame,
      ocr: payload.ocr || null,
      knownSensitiveText: payload.known_sensitive_text,
    });
    if (redaction.status !== 'redacted')
      return { status: 'withheld', reason: redaction.reason || 'frame_redaction_failed' };
    return { status: 'ready', text: payload.text, frame: redaction.frame, redaction };
  } catch (error) {
    return { status: 'withheld', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendThroughDistillationEgress<T>(
  payload: DistillationEgressPayload,
  send: (safe: DistillationEgressResult) => Promise<T>
): Promise<T | null> {
  const safe = prepareDistillationEgress(payload);
  if (safe.status !== 'ready') return null;
  return send(safe);
}

/** Text-only provider boundary for the central reasoning router. */
export function assertDistillationTextEgress(text: string): string {
  const safe = prepareDistillationEgress({ text });
  if (safe.status !== 'ready')
    throw new Error(`[DISTILLATION_EGRESS_DENIED] ${safe.reason || 'text_withheld'}`);
  return safe.text || text;
}
