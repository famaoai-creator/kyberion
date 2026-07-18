import { ocrImage } from '@agent/core';
import type { OcrRequest, OcrResult } from '@agent/core';

/**
 * Media-document OCR seam.
 *
 * Keeping the bridge behind a small actuator-local adapter lets document
 * readers share the governed OCR router while retaining a deterministic test
 * seam for PDF/PPTX conversion.
 */
export async function recognizeDocumentImage(request: OcrRequest): Promise<OcrResult> {
  return await ocrImage(request);
}
