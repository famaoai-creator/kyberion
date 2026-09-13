import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readDailyDeskRequestBody,
  runDailyDeskServer,
  DailyDeskRequestBodyTooLargeError,
  DAILY_DESK_DEFAULT_PORT,
  DAILY_DESK_MAX_BODY_BYTES,
  locateWorkingMemoryFaces,
  todayPeriodKey,
  validateDailyDeskContentLength,
} from './server.js';

describe('daily desk server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runDailyDeskServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: DAILY_DESK_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/daily-desk$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDailyDeskServer(['65536', '--check', '--quiet', '--tier', 'public']);
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('rejects tenant-bound startup for an unregistered tenant', async () => {
    await expect(
      main(['--tenant', 'unregistered-daily-desk-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-daily-desk-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(['--out', 'active/shared/tmp/daily-desk/demo', '--tier', 'public'], {
      dryRun: true,
      print: (value) => output.push(value),
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/daily-desk/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readDailyDeskRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readDailyDeskRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      DailyDeskRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateDailyDeskContentLength(undefined, DAILY_DESK_MAX_BODY_BYTES)).toBeUndefined();
    expect(validateDailyDeskContentLength('9', DAILY_DESK_MAX_BODY_BYTES)).toBe(9);
    expect(() => validateDailyDeskContentLength('not-a-number', DAILY_DESK_MAX_BODY_BYTES)).toThrow(
      DailyDeskRequestBodyTooLargeError
    );
    expect(() =>
      validateDailyDeskContentLength(
        String(DAILY_DESK_MAX_BODY_BYTES + 1),
        DAILY_DESK_MAX_BODY_BYTES
      )
    ).toThrow(DailyDeskRequestBodyTooLargeError);
  });

  it('resolves today period key and working-memory face locator without throwing', () => {
    expect(todayPeriodKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const faces = locateWorkingMemoryFaces();
    expect(faces.note.length).toBeGreaterThan(10);
    expect(typeof faces.journal).toBe('string');
    expect(typeof faces.todo).toBe('string');
    expect(typeof faces.now).toBe('string');
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/daily-desk/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = DAILY_DESK_REQUEST_TIMEOUT_MS');
    expect(source).toContain('DAILY_DESK_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain("kind: 'daily-desk-handoff'");
    expect(source).toContain('createLocalPadContext');
    expect(source).toContain('X-DD-Token');
  });
});
