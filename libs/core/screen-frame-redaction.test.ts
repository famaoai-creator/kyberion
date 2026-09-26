import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';

const { ocrImage, redactFrame } = vi.hoisted(() => ({ ocrImage: vi.fn(), redactFrame: vi.fn() }));

vi.mock('./ocr-bridge.js', () => ({ ocrImage }));
vi.mock('./frame-redaction.js', () => ({ redactFrame }));

import {
  createRedactedImageCopy,
  redactScreenCaptureFile,
  redactScreenVideoFrame,
} from './screen-frame-redaction.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import path from 'node:path';

async function fixturePng(): Promise<Buffer> {
  return new Jimp({ data: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 }).getBuffer(
    'image/png'
  );
}

describe('redactScreenCaptureFile', () => {
  it('writes only the redacted screenshot and removes the raw input', async () => {
    ocrImage.mockResolvedValue({
      status: 'succeeded',
      provider: 'fixture',
      text: '',
      confidence: 1,
      elapsedMs: 0,
      lines: [],
    });
    redactFrame.mockImplementation(({ frame }: any) => ({
      status: 'redacted',
      frame: { ...frame, pixels: new Uint8Array(frame.pixels.length).fill(0) },
      regions: [{ reason: 'fixture', x: 0, y: 0, width: frame.width, height: frame.height }],
    }));
    const input = pathResolver.sharedTmp('screen-redaction-tests/raw.png');
    const output = pathResolver.sharedTmp('screen-redaction-tests/redacted.png');
    safeRmSync(input, { force: true });
    safeRmSync(output, { force: true });
    safeWriteFile(input, await fixturePng());

    await redactScreenCaptureFile(input, output);

    expect(safeExistsSync(input)).toBe(false);
    expect(safeExistsSync(output)).toBe(true);
    expect((safeReadFile(output, { encoding: null }) as Buffer).length).toBeGreaterThan(0);
    safeRmSync(output, { force: true });
  });

  it('withholds the screenshot and removes raw input when OCR fails', async () => {
    ocrImage.mockResolvedValue({
      status: 'failed',
      provider: 'fixture',
      text: '',
      confidence: 0,
      elapsedMs: 0,
      lines: [],
      error: 'fixture failure',
    });
    redactFrame.mockReturnValue({ status: 'withheld', reason: 'ocr_failed' });
    const input = pathResolver.sharedTmp('screen-redaction-tests/raw-failed.png');
    const output = pathResolver.sharedTmp('screen-redaction-tests/redacted-failed.png');
    safeRmSync(input, { force: true });
    safeRmSync(output, { force: true });
    safeWriteFile(input, await fixturePng());

    await expect(redactScreenCaptureFile(input, output)).rejects.toThrow();

    expect(safeExistsSync(input)).toBe(false);
    expect(safeExistsSync(output)).toBe(false);
  });

  it('rejects a raw capture path replaced by a directory without removing it', async () => {
    const input = pathResolver.sharedTmp('screen-redaction-tests/raw-directory');
    const output = pathResolver.sharedTmp('screen-redaction-tests/redacted-directory.png');
    safeRmSync(input, { recursive: true, force: true });
    safeRmSync(output, { force: true });
    safeMkdir(input, { recursive: true });

    try {
      await expect(redactScreenCaptureFile(input, output)).rejects.toThrow(
        '[SCREEN_CAPTURE_RESOURCE] input must be a regular file'
      );
      expect(safeExistsSync(input)).toBe(true);
      expect(safeExistsSync(output)).toBe(false);
    } finally {
      safeRmSync(input, { recursive: true, force: true });
      safeRmSync(output, { force: true });
    }
  });
});

function succeedRedaction() {
  ocrImage.mockResolvedValue({
    status: 'succeeded',
    provider: 'fixture',
    text: '',
    confidence: 1,
    elapsedMs: 0,
    lines: [],
  });
  redactFrame.mockImplementation(({ frame }: { frame: { pixels: Uint8Array } }) => ({
    status: 'redacted',
    frame: { ...frame, pixels: new Uint8Array(frame.pixels.length).fill(0) },
    regions: [],
  }));
}

describe('redaction work files stay in scope', () => {
  const root = pathResolver.sharedTmp(`screen-redaction-scope-tests/${process.pid}`);

  it('redactScreenVideoFrame writes its OCR work file into work_dir only', async () => {
    succeedRedaction();
    const workDir = path.join(root, 'mission-tmp');
    try {
      const frame = {
        format: { mime_type: 'image/png' as const },
        payload: new Uint8Array(await fixturePng()),
        ts_ms: 7,
      };
      const redacted = await redactScreenVideoFrame(frame, { work_dir: workDir });
      expect(redacted.ts_ms).toBe(7);
      const ocrPath = ocrImage.mock.calls.at(-1)?.[0].path as string;
      expect(path.dirname(ocrPath)).toBe(workDir);
      expect(safeReaddir(workDir)).toEqual([]);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('redactScreenCaptureFile OCRs the capture in place instead of copying it', async () => {
    succeedRedaction();
    const input = path.join(root, 'in-place', 'raw.png');
    const output = path.join(root, 'in-place', 'redacted.png');
    try {
      safeWriteFile(input, await fixturePng());
      await redactScreenCaptureFile(input, output);
      expect(ocrImage.mock.calls.at(-1)?.[0].path).toBe(input);
      expect(safeReaddir(path.join(root, 'in-place'))).toEqual(['redacted.png']);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('createRedactedImageCopy leaves the source intact and disposes its work dir', async () => {
    succeedRedaction();
    const source = path.join(root, 'copy', 'photo.png');
    const workDir = path.join(root, 'copy-work');
    try {
      safeWriteFile(source, await fixturePng());
      const copy = await createRedactedImageCopy(source, { work_dir: workDir });
      expect(copy.path.startsWith(workDir + path.sep)).toBe(true);
      expect(safeExistsSync(source)).toBe(true);
      expect(safeReaddir(path.dirname(copy.path))).toEqual(['redacted.png']);
      copy.dispose();
      expect(safeReaddir(workDir)).toEqual([]);

      redactFrame.mockReturnValue({ status: 'withheld', reason: 'ocr_failed' });
      await expect(createRedactedImageCopy(source, { work_dir: workDir })).rejects.toThrow(
        'withheld'
      );
      expect(safeReaddir(workDir)).toEqual([]);
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });
});
