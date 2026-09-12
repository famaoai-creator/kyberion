import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readSketchInputRequestBody,
  runSketchInputServer,
  SketchInputRequestBodyTooLargeError,
  SKETCH_INPUT_DEFAULT_PORT,
  SKETCH_INPUT_MAX_BODY_BYTES,
  validateSketchInputContentLength,
} from './server.js';

describe('sketch input server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runSketchInputServer(['--dry-run', '--quiet']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: SKETCH_INPUT_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/sketch-input\/latest\.png$/);
    expect(result?.handoff).toMatch(/\.handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runSketchInputServer(['65536', '--check', '--quiet']);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['--out', 'active/shared/tmp/sketch-input/demo.png'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/sketch-input/demo.png',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readSketchInputRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readSketchInputRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      SketchInputRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateSketchInputContentLength()).toBeUndefined();
    expect(validateSketchInputContentLength('9')).toBe(9);
    expect(() => validateSketchInputContentLength('not-a-number')).toThrow(
      SketchInputRequestBodyTooLargeError
    );
    expect(() => validateSketchInputContentLength(String(SKETCH_INPUT_MAX_BODY_BYTES + 1))).toThrow(
      SketchInputRequestBodyTooLargeError
    );
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/sketch-input/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = SKETCH_INPUT_REQUEST_TIMEOUT_MS');
    expect(source).toContain('SKETCH_INPUT_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
  });
});
