import { describe, expect, it } from 'vitest';
import { pathResolver, safeWriteFile, safeStat } from '@agent/core';
import { RECORD_USAGE, renderRecordResult, runRecordCommand } from './cli-record.js';

describe('pnpm kyberion record screen', () => {
  it('records the screen through the injected runner and prints a repo-relative summary', async () => {
    const out = 'active/shared/tmp/record-screen-test.mp4';
    const absolute = pathResolver.rootResolve(out);
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runRecordCommand(
      ['--duration', '7', '--out', out],
      (t) => output.push(t),
      {
        async record(input) {
          seen.push(input);
          const params = input.params as Record<string, unknown>;
          safeWriteFile(String(params.output), Buffer.from('fake-mp4'));
          return { screen_recording: { output_path: String(params.output) } };
        },
      }
    );
    expect(seen[0]).toMatchObject({
      action: 'system:record_screen',
      params: { capture_mode: 'screen', duration: 7, export_as: 'screen_recording' },
    });
    expect(result).toMatchObject({ out, duration_s: 7, source: 'screen' });
    expect(safeStat(absolute).size).toBe(8);
    expect(output.join('\n')).toContain(`[record] wrote ${out}`);
  });

  it('validates duration, out, and unknown options, and prints usage', async () => {
    await expect(runRecordCommand(['--duration', '0'], () => {})).rejects.toThrow(
      /--duration must be/
    );
    await expect(runRecordCommand(['--duration', '301'], () => {})).rejects.toThrow(
      /--duration must be/
    );
    await expect(runRecordCommand(['--duration'], () => {})).rejects.toThrow(/requires seconds/);
    await expect(
      runRecordCommand(['--out', 'active/shared/tmp/x.wav'], () => {}, {
        async record() {
          return {};
        },
      })
    ).rejects.toThrow(/unsupported file type/);
    await expect(runRecordCommand(['--audio'], () => {})).rejects.toThrow(/Unknown option/);
    await expect(runRecordCommand(['--bogus'], () => {})).rejects.toThrow(/Unknown option/);
    const output: string[] = [];
    await runRecordCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(RECORD_USAGE);
  });

  it('surfaces actuator failures and unreadable outputs as governed errors', async () => {
    await expect(
      runRecordCommand(['--out', 'active/shared/tmp/rec-fail.mp4'], () => {}, {
        async record() {
          throw new Error('no encoder');
        },
      })
    ).rejects.toThrow(/system:record_screen failed: no encoder/);
    await expect(
      runRecordCommand(['--out', 'active/shared/tmp/rec-missing.mp4'], () => {}, {
        async record(input) {
          return {
            screen_recording: { output_path: (input.params as Record<string, unknown>).output },
          };
        },
      })
    ).rejects.toThrow(/reported success but .* unreadable/);
  });

  it('renders JSON explicitly', () => {
    expect(
      renderRecordResult(
        { out: 'a.mp4', bytes: 1, duration_s: 5, source: 'screen', warnings: [] },
        true
      )
    ).toContain('"out": "a.mp4"');
  });
});
