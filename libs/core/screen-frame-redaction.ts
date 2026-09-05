import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Jimp } from 'jimp';
import { ocrImage } from './ocr-bridge.js';
import { redactFrame } from './frame-redaction.js';
import { pathResolver } from './path-resolver.js';
import { safeLstat, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import type { VideoFrame } from './meeting-session-types.js';

/**
 * Screen frames are captured into the volatile shared tmp scope only long
 * enough for OCR and redaction. The archive receives the redacted PNG, never
 * the capture payload.
 */
export async function redactScreenVideoFrame(frame: VideoFrame): Promise<VideoFrame> {
  const tempPath = pathResolver.sharedTmp(
    path.join('screen-redaction', `frame-${randomUUID()}.png`)
  );
  safeWriteFile(tempPath, Buffer.from(frame.payload));
  try {
    const image = await Jimp.read(Buffer.from(frame.payload));
    const ocr = await ocrImage({ path: tempPath, mode: 'privacy_first' });
    const redaction = redactFrame({
      frame: {
        width: image.bitmap.width,
        height: image.bitmap.height,
        pixels: new Uint8Array(image.bitmap.data),
      },
      ocr,
    });
    if (redaction.status !== 'redacted' || !redaction.frame) {
      throw new Error(`screen frame withheld: ${redaction.reason || 'redaction_failed'}`);
    }
    const redactedImage = new Jimp({
      data: Buffer.from(redaction.frame.pixels),
      width: redaction.frame.width,
      height: redaction.frame.height,
    });
    const payload = await redactedImage.getBuffer('image/png');
    return {
      format: {
        mime_type: 'image/png',
        width: redaction.frame.width,
        height: redaction.frame.height,
      },
      payload: new Uint8Array(payload),
      ts_ms: frame.ts_ms,
    };
  } finally {
    safeRmSync(tempPath, { force: true });
  }
}

/**
 * Redact a single screenshot before it becomes a durable artifact.
 * The raw capture is always removed, including when OCR or masking fails.
 */
export async function redactScreenCaptureFile(
  inputPath: string,
  outputPath: string
): Promise<void> {
  try {
    if (!safeLstat(inputPath).isFile()) {
      throw new Error(`[SCREEN_CAPTURE_RESOURCE] input must be a regular file: ${inputPath}`);
    }
    const payload = safeReadFile(inputPath, { encoding: null });
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const format: VideoFrame['format'] = {
      mime_type: /^\x89PNG/.test(buffer.toString('latin1')) ? 'image/png' : 'image/jpeg',
      width: 0,
      height: 0,
    };
    safeRmSync(outputPath, { force: true });
    const redacted = await redactScreenVideoFrame({
      format,
      payload: new Uint8Array(buffer),
      ts_ms: Date.now(),
    });
    safeMkdir(path.dirname(outputPath), { recursive: true });
    safeWriteFile(outputPath, Buffer.from(redacted.payload));
  } catch (error) {
    safeRmSync(outputPath, { force: true });
    throw error;
  } finally {
    try {
      if (!safeLstat(inputPath).isDirectory()) safeRmSync(inputPath, { force: true });
    } catch {
      // A missing or non-removable capture must not mask the redaction result.
    }
  }
}
