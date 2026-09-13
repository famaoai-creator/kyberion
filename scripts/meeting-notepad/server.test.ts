import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  main,
  readMeetingNotepadRequestBody,
  runMeetingNotepadServer,
  MeetingNotepadRequestBodyTooLargeError,
  MEETING_NOTEPAD_DEFAULT_PORT,
  MEETING_NOTEPAD_MAX_BODY_BYTES,
  validateMeetingNotepadContentLength,
} from './server.js';

describe('meeting notepad server harness boundary', () => {
  it('validates configuration without binding in dry-run mode', async () => {
    const result = await runMeetingNotepadServer(['--dry-run', '--quiet', '--tier', 'public']);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: MEETING_NOTEPAD_DEFAULT_PORT,
      listening: false,
    });
    expect(result?.out).toMatch(/meeting-notepad$/);
    expect(result?.handoff).toMatch(/handoff\.json$/);
  });

  it('rejects ports outside the TCP port range', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runMeetingNotepadServer([
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
      main(['--tenant', 'unregistered-meeting-tenant', '--tier', 'public'], { dryRun: true })
    ).rejects.toThrow("tenant 'unregistered-meeting-tenant' has no profile");
  });

  it('routes dry-run output through the injected printer', async () => {
    const output: unknown[] = [];
    const result = await main(
      ['--out', 'active/shared/tmp/meeting-notepad/demo', '--tier', 'public'],
      {
        dryRun: true,
        print: (value) => output.push(value),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      listening: false,
      out: 'active/shared/tmp/meeting-notepad/demo',
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: true, mode: 'dry-run' });
  });

  it('bounds request bodies by UTF-8 bytes', async () => {
    async function* chunks() {
      yield '日本';
      yield Buffer.from('語', 'utf8');
    }

    await expect(readMeetingNotepadRequestBody(chunks(), 9)).resolves.toBe('日本語');
    await expect(readMeetingNotepadRequestBody(chunks(), 8)).rejects.toBeInstanceOf(
      MeetingNotepadRequestBodyTooLargeError
    );
  });

  it('rejects invalid and oversized declared request lengths before reading the body', () => {
    expect(validateMeetingNotepadContentLength()).toBeUndefined();
    expect(validateMeetingNotepadContentLength('9')).toBe(9);
    expect(() => validateMeetingNotepadContentLength('not-a-number')).toThrow(
      MeetingNotepadRequestBodyTooLargeError
    );
    expect(() =>
      validateMeetingNotepadContentLength(String(MEETING_NOTEPAD_MAX_BODY_BYTES + 1))
    ).toThrow(MeetingNotepadRequestBodyTooLargeError);
  });

  it('keeps runtime output and exit handling behind the harness boundary', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/meeting-notepad/server.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('getRegisteredEnvText, nowIso');
    expect(source).toContain('server.requestTimeout = MEETING_NOTEPAD_REQUEST_TIMEOUT_MS');
    expect(source).toContain('MEETING_NOTEPAD_MAX_CONCURRENT_HEAVY_REQUESTS');
    expect(source).toContain('request body too large');
    expect(source).toContain('resolveTenant(requestedTenant.trim())');
    expect(source).toContain('CLI tenant does not match server-side KYBERION_TENANT scope');
    expect(source).toContain('require server-side KYBERION_TENANT scope');
    expect(source).toContain('lifecyclePrincipal(notepadContext.viewer_principal)');
  });
});
