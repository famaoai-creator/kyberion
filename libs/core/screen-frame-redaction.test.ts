import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';

const { ocrImage, redactFrame } = vi.hoisted(() => ({ ocrImage: vi.fn(), redactFrame: vi.fn() }));

vi.mock('./ocr-bridge.js', () => ({ ocrImage }));
vi.mock('./frame-redaction.js', () => ({ redactFrame }));

import { redactScreenCaptureFile } from './screen-frame-redaction.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

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
});
