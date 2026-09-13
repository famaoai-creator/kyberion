import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readDocDropRequestBody,
  runDocDropServer,
  DocDropRequestBodyTooLargeError,
  DOC_DROP_DEFAULT_PORT,
  DOC_DROP_MAX_BODY_BYTES,
  DOC_DROP_MAX_FILE_BYTES,
  validateDocDropContentLength,
} from './server.js';

describe('doc drop server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runDocDropServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: DOC_DROP_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/doc-drop$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDocDropServer(['65536', '--check', '--quiet', '--tier', 'public']);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects tenant-bound startup for an unregistered tenant', async () => {
    await expect(
      main(['--tenant', 'unregistered-doc-drop-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-doc-drop-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['--out', 'active/shared/tmp/doc-drop/demo', '--tier', 'public'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/doc-drop/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readDocDropRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readDocDropRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      DocDropRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateDocDropContentLength(undefined, DOC_DROP_MAX_BODY_BYTES)).toBeUndefined();
    expect(validateDocDropContentLength('9', DOC_DROP_MAX_BODY_BYTES)).toBe(9);
    expect(() => validateDocDropContentLength('not-a-number', DOC_DROP_MAX_BODY_BYTES)).toThrow(
      DocDropRequestBodyTooLargeError
    );
    expect(() =>
      validateDocDropContentLength(String(DOC_DROP_MAX_BODY_BYTES + 1), DOC_DROP_MAX_BODY_BYTES)
    ).toThrow(DocDropRequestBodyTooLargeError);
    expect(DOC_DROP_MAX_FILE_BYTES).toBe(12 * 1024 * 1024);
    expect(DOC_DROP_MAX_BODY_BYTES).toBe(24 * 1024 * 1024);
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/doc-drop/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = DOC_DROP_REQUEST_TIMEOUT_MS');
    expect(source).toContain('DOC_DROP_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain("kind: 'doc-drop-handoff'");
    expect(source).toContain("suggested_ops: ['ingest:parse_document', 'vision:ocr_image']");
    expect(source).toContain('createLocalPadContext');
    expect(source).toContain('X-DDROP-Token');
    expect(source).toContain('X-DOC-Token');
  });
});
