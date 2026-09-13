import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readScreenshotAnnotateRequestBody,
  runScreenshotAnnotateServer,
  ScreenshotAnnotateRequestBodyTooLargeError,
  SCREENSHOT_ANNOTATE_DEFAULT_PORT,
  SCREENSHOT_ANNOTATE_MAX_BODY_BYTES,
  validateScreenshotAnnotateContentLength,
} from './server.js';

describe('screenshot annotate server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runScreenshotAnnotateServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: SCREENSHOT_ANNOTATE_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/screenshot-annotate$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runScreenshotAnnotateServer([
        '65536',
        '--check',
        '--quiet',
        '--tier',
        'public',
      ]);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects tenant-bound startup for an unregistered tenant', async () => {
    await expect(
      main(['--tenant', 'unregistered-screenshot-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-screenshot-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(
      ['--out', 'active/shared/tmp/screenshot-annotate/demo', '--tier', 'public'],
      {
        dryRun: true,
        print: (value) => output.push(value),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/screenshot-annotate/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readScreenshotAnnotateRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readScreenshotAnnotateRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      ScreenshotAnnotateRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateScreenshotAnnotateContentLength()).toBeUndefined();
    expect(validateScreenshotAnnotateContentLength('9')).toBe(9);
    expect(() => validateScreenshotAnnotateContentLength('not-a-number')).toThrow(
      ScreenshotAnnotateRequestBodyTooLargeError
    );
    expect(() =>
      validateScreenshotAnnotateContentLength(String(SCREENSHOT_ANNOTATE_MAX_BODY_BYTES + 1))
    ).toThrow(ScreenshotAnnotateRequestBodyTooLargeError);
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/screenshot-annotate/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = SCREENSHOT_ANNOTATE_REQUEST_TIMEOUT_MS');
    expect(source).toContain('SCREENSHOT_ANNOTATE_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain('x-sa-token');
    expect(source).toContain('resolveTenant(requestedTenant.trim())');
  });
});
