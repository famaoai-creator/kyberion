import * as path from 'node:path';
import { logger } from '../../core.js';
import {
  OcrRequest,
  OcrResult,
  OcrProvider,
  OcrDataEgress,
  OcrRoutingMode,
} from '../../ocr-types.js';
import { resolveOcrImagePath, toTesseractLanguage } from '../provider-support.js';

export class TesseractOcrProvider implements OcrProvider {
  readonly id = 'tesseract';
  readonly dataEgress = 'none' as const; // tesseract.js, in-process

  async isAvailable(): Promise<boolean> {
    try {
      await import('tesseract.js');
      return true;
    } catch (_) {
      return false;
    }
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const startedAt = Date.now();
    const resolvedPath = resolveOcrImagePath(request.path);
    const lang = toTesseractLanguage(request.language);
    let worker: any = null;
    const abortWorker = () => {
      if (worker) void worker.terminate().catch(() => undefined);
    };

    try {
      const { createWorker } = await import('tesseract.js');
      // Without an errorHandler tesseract.js rethrows worker failures (e.g. a
      // missing traineddata download) as an uncaught exception that kills the
      // process; with it they reject createWorker/recognize and land below.
      worker = await createWorker(lang, undefined, {
        errorHandler: (error: unknown) =>
          logger.warn(`[ocr_bridge] Tesseract worker error: ${String(error)}`),
      });
      if (request.signal?.aborted) {
        await worker.terminate();
        worker = null;
        throw new Error('OCR cancelled before recognition');
      }
      request.signal?.addEventListener('abort', abortWorker, { once: true });
      // `lines` are derived from Tesseract's block output. The default output
      // only returns plain text, which is fine for `see` but cannot safely
      // redact a screen frame because it has no pixel coordinates.
      const result = await worker.recognize(resolvedPath, {}, { blocks: true });
      const recognizedLines = Array.isArray(result.data.blocks)
        ? result.data.blocks.flatMap((block: any) =>
            (block.paragraphs || []).flatMap((paragraph: any) => paragraph.lines || [])
          )
        : undefined;

      return {
        status: 'succeeded',
        provider: this.id,
        text: result.data.text,
        confidence: result.data.confidence,
        lines: recognizedLines?.map((line: any) => ({
          text: line.text,
          confidence: line.confidence,
          boundingBox: line.bbox
            ? {
                x: line.bbox.x0,
                y: line.bbox.y0,
                width: line.bbox.x1 - line.bbox.x0,
                height: line.bbox.y1 - line.bbox.y0,
              }
            : undefined,
        })),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[ocr_bridge] Tesseract execution failed: ${error.message}`);
      return {
        status: 'failed',
        provider: this.id,
        text: '',
        confidence: 0,
        error: error.message || 'tesseract_recognition_failed',
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      request.signal?.removeEventListener('abort', abortWorker);
      if (worker) {
        try {
          await worker.terminate();
        } catch (terminateError: any) {
          logger.warn(
            `[ocr_bridge] Tesseract worker terminate failed: ${terminateError?.message || terminateError}`
          );
        }
      }
    }
  }
}
