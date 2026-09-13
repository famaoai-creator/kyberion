import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readClipboardInboxRequestBody,
  readOsClipboardText,
  runClipboardInboxServer,
  ClipboardInboxRequestBodyTooLargeError,
  CLIPBOARD_INBOX_DEFAULT_PORT,
  CLIPBOARD_INBOX_MAX_BODY_BYTES,
  validateClipboardInboxContentLength,
} from './server.js';

describe('clipboard inbox server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runClipboardInboxServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: CLIPBOARD_INBOX_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/clipboard-inbox$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runClipboardInboxServer([
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
      main(['--tenant', 'unregistered-clipboard-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-clipboard-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(
      ['--out', 'active/shared/tmp/clipboard-inbox/demo', '--tier', 'public'],
      {
        dryRun: true,
        print: (value) => output.push(value),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/clipboard-inbox/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readClipboardInboxRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readClipboardInboxRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      ClipboardInboxRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateClipboardInboxContentLength()).toBeUndefined();
    expect(validateClipboardInboxContentLength('9')).toBe(9);
    expect(() => validateClipboardInboxContentLength('not-a-number')).toThrow(
      ClipboardInboxRequestBodyTooLargeError
    );
    expect(() =>
      validateClipboardInboxContentLength(String(CLIPBOARD_INBOX_MAX_BODY_BYTES + 1))
    ).toThrow(ClipboardInboxRequestBodyTooLargeError);
  });

  it('reads OS clipboard without throwing when the tool is missing', async () => {
    const result = await readOsClipboardText();
    expect(result).toHaveProperty('ok');
    if ('error' in result) {
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      expect(typeof result.text).toBe('string');
    }
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/clipboard-inbox/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = CLIPBOARD_INBOX_REQUEST_TIMEOUT_MS');
    expect(source).toContain('CLIPBOARD_INBOX_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain('x-ci-token');
    expect(source).toContain('resolveTenant(requestedTenant.trim())');
    expect(source).toContain('redact_hint');
  });
});
