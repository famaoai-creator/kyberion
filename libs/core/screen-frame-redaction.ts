import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Jimp } from 'jimp';
import { ocrImage } from './ocr-bridge.js';
import { redactFrame } from './frame-redaction.js';
import { pathResolver } from './path-resolver.js';
import { safeLstat, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import type { VideoFrame } from './meeting-session-types.js';

export interface ScreenRedactionOptions {
  /**
   * Scope-local directory for transient copies of the raw capture. Defaults to
   * the volatile shared tmp floor; non-public captures must pass their mission
   * directory so raw pixels never leave their scope.
   */
  work_dir?: string;
}

function defaultWorkDir(): string {
  return pathResolver.sharedTmp('screen-redaction');
}

/** OCR `ocrPath` (holding `payload`) and return the redacted PNG frame. */
async function redactPayload(payload: Buffer, ocrPath: string, tsMs: number): Promise<VideoFrame> {
  const image = await Jimp.read(payload);
  const ocr = await ocrImage({ path: ocrPath, mode: 'privacy_first' });
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
  const redacted = await redactedImage.getBuffer('image/png');
  return {
    format: {
      mime_type: 'image/png',
      width: redaction.frame.width,
      height: redaction.frame.height,
    },
    payload: new Uint8Array(redacted),
    ts_ms: tsMs,
  };
}

/**
 * Screen frames are written to a work file only long enough for OCR and
 * redaction. The archive receives the redacted PNG, never the capture payload.
 */
export async function redactScreenVideoFrame(
  frame: VideoFrame,
  options: ScreenRedactionOptions = {}
): Promise<VideoFrame> {
  const workDir = options.work_dir ?? defaultWorkDir();
  const tempPath = path.join(workDir, `frame-${randomUUID()}.png`);
  safeMkdir(workDir, { recursive: true });
  safeWriteFile(tempPath, Buffer.from(frame.payload));
  try {
    return await redactPayload(Buffer.from(frame.payload), tempPath, frame.ts_ms);
  } finally {
    safeRmSync(tempPath, { force: true });
  }
}

/**
 * Redact a single screenshot before it becomes a durable artifact. OCR reads
 * the capture in place, so no copy of it is made anywhere else. The raw
 * capture is always removed, including when OCR or masking fails.
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
    safeRmSync(outputPath, { force: true });
    const redacted = await redactPayload(buffer, inputPath, Date.now());
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

export interface RedactedImageCopy {
  /** Redacted PNG; safe to hand to an off-machine consumer. */
  path: string;
  /** Removes the redacted copy and its work directory. */
  dispose: () => void;
}

/**
 * Redacted PNG copy of an image, for payloads that leave the machine. The
 * source file is read, never modified; the raw copy lives in work_dir only
 * for the duration of the redaction.
 */
export async function createRedactedImageCopy(
  inputPath: string,
  options: ScreenRedactionOptions & {
    redact?: (inputPath: string, outputPath: string) => Promise<void>;
  } = {}
): Promise<RedactedImageCopy> {
  const dir = path.join(options.work_dir ?? defaultWorkDir(), `copy-${randomUUID()}`);
  const dispose = () => safeRmSync(dir, { recursive: true, force: true });
  safeMkdir(dir, { recursive: true });
  try {
    if (!safeLstat(inputPath).isFile()) {
      throw new Error(`[SCREEN_CAPTURE_RESOURCE] input must be a regular file: ${inputPath}`);
    }
    const rawPath = path.join(dir, `raw${path.extname(inputPath).toLowerCase() || '.png'}`);
    const redactedPath = path.join(dir, 'redacted.png');
    safeWriteFile(rawPath, safeReadFile(inputPath, { encoding: null }) as Buffer);
    await (options.redact ?? redactScreenCaptureFile)(rawPath, redactedPath);
    safeRmSync(rawPath, { force: true });
    return { path: redactedPath, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
