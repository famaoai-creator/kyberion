import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeWriteFile, safeStat } from '@agent/core';
import {
  CAPTURE_USAGE,
  buildPhotoPipelineInput,
  buildScreenshotPipelineInput,
  renderCaptureResult,
  runCaptureCommand,
} from './cli-capture.js';

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
  it('builds pipeline-steps inputs (the only form the system-actuator executes)', () => {
    expect(buildScreenshotPipelineInput('/tmp/a.png', 'screen')).toEqual({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'screenshot',
          params: { capture_mode: 'screen', path: '/tmp/a.png', export_as: 'screenshot_path' },
        },
      ],
    });
    expect(buildPhotoPipelineInput('/tmp/b.jpg')).toMatchObject({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'capture_photo' }],
    });
  });

  it('captures the screen through the injected runner and prints a repo-relative summary', async () => {
    const out = 'active/shared/tmp/capture-screen-test.png';
    const absolute = pathResolver.rootResolve(out);
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runCaptureCommand(['--screen', '--out', out], (t) => output.push(t), {
      async capture(input) {
        seen.push(input);
        const step = (input.steps as Array<Record<string, unknown>>)[0]!;
        const params = step.params as Record<string, unknown>;
        safeWriteFile(String(params.path), pngHeader(320, 200));
        return { status: 'succeeded', context: { screenshot_path: String(params.path) } };
      },
    });
    expect(seen[0]).toMatchObject({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'screenshot' }],
    });
    expect(result).toMatchObject({ out, mode: 'screen', width: 320, height: 200 });
    expect(safeStat(absolute).size).toBe(33);
    expect(output.join('\n')).toContain(`[capture] wrote ${out}`);
  });

  it('maps --window to focused_window mode and --camera to capture_photo', async () => {
    const seen: Record<string, unknown>[] = [];
    const photoOut = 'active/shared/tmp/capture-camera-test.jpg';
    await runCaptureCommand(
      ['--window', '--out', 'active/shared/tmp/capture-window-test.png'],
      () => {},
      {
        async capture(input) {
          seen.push(input);
          const step = (input.steps as Array<Record<string, unknown>>)[0]!;
          const params = step.params as Record<string, unknown>;
          safeWriteFile(String(params.path), pngHeader(100, 50));
          return { status: 'succeeded', context: { screenshot_path: String(params.path) } };
        },
      }
    );
    const windowStep = (seen[0]!.steps as Array<Record<string, unknown>>)[0]!;
    expect(windowStep.op).toBe('screenshot');
    expect((windowStep.params as Record<string, unknown>).capture_mode).toBe('focused_window');

    const output: string[] = [];
    const result = await runCaptureCommand(['--camera', '--out', photoOut], (t) => output.push(t), {
      async capture(input) {
        seen.push(input);
        const step = (input.steps as Array<Record<string, unknown>>)[0]!;
        const params = step.params as Record<string, unknown>;
        safeWriteFile(String(params.path), pngHeader(640, 480));
        return { status: 'succeeded', context: { photo_path: String(params.path) } };
      },
    });
    const photoStep = (seen[1]!.steps as Array<Record<string, unknown>>)[0]!;
    expect(photoStep.op).toBe('capture_photo');
    expect(result).toMatchObject({ out: photoOut, mode: 'camera' });
    expect(output.join('\n')).toContain(`[capture] wrote ${photoOut}`);
  });

  it('rejects bad outs, unknown options, and prints usage', async () => {
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
      runCaptureCommand(['--camera', '--out', 'active/shared/tmp/cap-cam-fail.jpg'], () => {}, {
        async capture() {
          throw new Error('no camera');
        },
      })
    ).rejects.toThrow(/system:capture_photo failed: no camera/);
    await expect(
      runCaptureCommand(['--screen', '--out', 'active/shared/tmp/cap-missing.png'], () => {}, {
        async capture() {
          return { status: 'succeeded', context: {} };
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
