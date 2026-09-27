import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeWriteFile, safeStat } from '@agent/core';
import { CAPTURE_USAGE, renderCaptureResult, runCaptureCommand } from './cli-capture.js';

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('pnpm kyberion capture', () => {
  it('captures the screen through the injected runner and prints a repo-relative summary', async () => {
    const out = 'active/shared/tmp/capture-screen-test.png';
    const absolute = pathResolver.rootResolve(out);
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runCaptureCommand(['--screen', '--out', out], (t) => output.push(t), {
      async capture(input) {
        seen.push(input);
        const params = input.params as Record<string, unknown>;
        safeWriteFile(String(params.path), pngHeader(320, 200));
        return { screenshot_path: String(params.path) };
      },
    });
    expect(seen[0]).toMatchObject({
      action: 'system:screenshot',
      params: { capture_mode: 'screen', export_as: 'screenshot_path' },
    });
    expect(result).toMatchObject({ out, mode: 'screen', width: 320, height: 200 });
    expect(safeStat(absolute).size).toBe(33);
    expect(output.join('\n')).toContain(`[capture] wrote ${out}`);
  });

  it('maps --window to focused_window mode', async () => {
    const seen: Record<string, unknown>[] = [];
    await runCaptureCommand(
      ['--window', '--out', 'active/shared/tmp/capture-window-test.png'],
      () => {},
      {
        async capture(input) {
          seen.push(input);
          const params = input.params as Record<string, unknown>;
          safeWriteFile(String(params.path), pngHeader(100, 50));
          return { screenshot_path: String(params.path) };
        },
      }
    );
    expect((seen[0]!.params as Record<string, unknown>).capture_mode).toBe('focused_window');
  });

  it('rejects --camera with P2 guidance, bad outs, and prints usage', async () => {
    await expect(runCaptureCommand(['--camera'], () => {})).rejects.toThrow(/P2.*capture_photo/);
    await expect(
      runCaptureCommand(['--screen', '--out', 'active/shared/tmp/x.txt'], () => {}, {
        async capture() {
          return {};
        },
      })
    ).rejects.toThrow(/unsupported file type/);
    await expect(
      runCaptureCommand(['--screen', '--out', '/tmp/evil.png'], () => {}, {
        async capture() {
          return {};
        },
      })
    ).rejects.toThrow(/inside the repository/);
    await expect(runCaptureCommand(['--bogus'], () => {})).rejects.toThrow(/Unknown option/);
    const output: string[] = [];
    await runCaptureCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(CAPTURE_USAGE);
  });

  it('surfaces actuator failures and unreadable outputs as governed errors', async () => {
    await expect(
      runCaptureCommand(['--screen', '--out', 'active/shared/tmp/cap-fail.png'], () => {}, {
        async capture() {
          throw new Error('no display');
        },
      })
    ).rejects.toThrow(/system:screenshot failed: no display/);
    await expect(
      runCaptureCommand(['--screen', '--out', 'active/shared/tmp/cap-missing.png'], () => {}, {
        async capture(input) {
          return { screenshot_path: (input.params as Record<string, unknown>).path };
        },
      })
    ).rejects.toThrow(/reported success but .* unreadable/);
  });

  it('renders JSON and dims explicitly', () => {
    expect(
      renderCaptureResult({ out: 'a.png', bytes: 10, mode: 'screen', warnings: ['w'] }, true)
    ).toContain('"out": "a.png"');
    expect(
      renderCaptureResult(
        { out: 'a.png', bytes: 10, width: 8, height: 6, mode: 'window', warnings: [] },
        false
      )
    ).toContain('8x6');
  });
});
