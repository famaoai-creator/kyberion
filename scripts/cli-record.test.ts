import { describe, expect, it } from 'vitest';
import { pathResolver, safeWriteFile, safeStat } from '@agent/core';
import {
  RECORD_USAGE,
  buildRecordAudioPipelineInput,
  buildRecordCameraPipelineInput,
  buildRecordScreenPipelineInput,
  renderRecordResult,
  runRecordCommand,
} from './cli-record.js';

describe('pnpm kyberion record', () => {
  it('builds pipeline-steps inputs (the only form the system-actuator executes)', () => {
    expect(buildRecordScreenPipelineInput('/tmp/a.mp4', 7)).toEqual({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'record_screen',
          params: {
            capture_mode: 'screen',
            duration: 7,
            output: '/tmp/a.mp4',
            export_as: 'screen_recording',
          },
        },
      ],
    });
    expect(
      buildRecordAudioPipelineInput({ durationS: 5, output: '/tmp/b.wav', device: 'Mic' })
    ).toEqual({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'record_audio',
          params: {
            duration: 5,
            output: '/tmp/b.wav',
            targets: ['Mic'],
            export_as: 'audio_recording',
          },
        },
      ],
    });
    expect(buildRecordCameraPipelineInput('/tmp/c.mp4', 6)).toEqual({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'record_camera',
          params: { duration: 6, output: '/tmp/c.mp4', export_as: 'camera_recording' },
        },
      ],
    });
  });

  it('records the screen through the injected runner and prints a repo-relative summary', async () => {
    const out = 'active/shared/tmp/record-screen-test.mp4';
    const absolute = pathResolver.rootResolve(out);
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runRecordCommand(
      ['--screen', '--duration', '7', '--out', out],
      (t) => output.push(t),
      {
        async record(input) {
          seen.push(input);
          const step = (input.steps as Array<Record<string, unknown>>)[0]!;
          const params = step.params as Record<string, unknown>;
          safeWriteFile(String(params.output), Buffer.from('fake-mp4'));
          return {
            status: 'succeeded',
            context: { screen_recording: { output_path: String(params.output) } },
          };
        },
      }
    );
    expect(seen[0]).toMatchObject({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'record_screen' }],
    });
    expect(result).toMatchObject({ out, duration_s: 7, source: 'screen' });
    expect(safeStat(absolute).size).toBe(8);
    expect(output.join('\n')).toContain(`[record] wrote ${out}`);
  });

  it('records one audio input to a single file', async () => {
    const out = 'active/shared/tmp/record-audio-test.wav';
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runRecordCommand(
      ['--audio', '--device', 'Built-in Microphone', '--duration', '4', '--out', out],
      (t) => output.push(t),
      {
        async record(input) {
          seen.push(input);
          const step = (input.steps as Array<Record<string, unknown>>)[0]!;
          const params = step.params as Record<string, unknown>;
          safeWriteFile(String(params.output), Buffer.from('fake-wav'));
          return {
            status: 'succeeded',
            context: {
              audio_recording: {
                recordings: [
                  {
                    device_name: 'Built-in Microphone',
                    status: 'recorded',
                    recorded_path: String(params.output),
                  },
                ],
              },
            },
          };
        },
      }
    );
    expect(seen[0]).toMatchObject({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'record_audio' }],
    });
    expect(result).toMatchObject({ out, duration_s: 4, source: 'audio' });
    expect(output.join('\n')).toContain(`[record] wrote ${out}`);
  });

  it('records camera video through the injected runner', async () => {
    const out = 'active/shared/tmp/record-camera-test.mp4';
    const output: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const result = await runRecordCommand(
      ['--camera', '--duration', '6', '--out', out],
      (t) => output.push(t),
      {
        async record(input) {
          seen.push(input);
          const step = (input.steps as Array<Record<string, unknown>>)[0]!;
          const params = step.params as Record<string, unknown>;
          safeWriteFile(String(params.output), Buffer.from('fake-cam'));
          return {
            status: 'succeeded',
            context: { camera_recording: { output_path: String(params.output) } },
          };
        },
      }
    );
    expect(seen[0]).toMatchObject({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'record_camera' }],
    });
    expect(result).toMatchObject({ out, duration_s: 6, source: 'camera' });
    expect(output.join('\n')).toContain(`[record] wrote ${out}`);
  });

  it('summarizes multi-input audio recordings as a directory', async () => {
    const dir = 'active/shared/tmp/record-audio-multi';
    const files = [`${dir}/mic-a.wav`, `${dir}/mic-b.wav`];
    for (const file of files) safeWriteFile(pathResolver.rootResolve(file), Buffer.from('x'));
    const output: string[] = [];
    const result = await runRecordCommand(['--audio', '--duration', '3'], (t) => output.push(t), {
      async record() {
        return {
          status: 'succeeded',
          context: {
            audio_recording: {
              recordings: files.map((file, index) => ({
                device_name: `Mic ${index}`,
                status: 'recorded',
                recorded_path: pathResolver.rootResolve(file),
              })),
            },
          },
        };
      },
    });
    expect(result).toMatchObject({ out: dir, source: 'audio', files });
    expect(output.join('\n')).toContain('2 audio files');
  });

  it('fails closed on audio errors and validates args', async () => {
    await expect(
      runRecordCommand(['--audio', '--out', 'active/shared/tmp/x.wav'], () => {}, {
        async record() {
          return {
            status: 'succeeded',
            context: {
              audio_recording: {
                recordings: [
                  { device_name: 'Mic', status: 'failed', recorded_path: 'x', error: 'busy' },
                ],
              },
            },
          };
        },
      })
    ).rejects.toThrow(/1 input\(s\) failed: Mic: busy/);
    await expect(
      runRecordCommand(['--audio', '--out', 'active/shared/tmp/x.wav'], () => {}, {
        async record() {
          return { status: 'succeeded', context: { audio_recording: { recordings: [] } } };
        },
      })
    ).rejects.toThrow(/no recordings/);
    await expect(
      runRecordCommand(['--screen', '--device', 'Mic'], () => {}, {
        async record() {
          return {};
        },
      })
    ).rejects.toThrow(/--device only applies/);
    await expect(runRecordCommand(['--screen', '--audio'], () => {})).rejects.toThrow(/one of/);
    await expect(runRecordCommand(['--camera', '--duration', '61'], () => {})).rejects.toThrow(
      /1-60 seconds/
    );
    await expect(runRecordCommand(['--duration', '0'], () => {})).rejects.toThrow(
      /--duration must be/
    );
    await expect(runRecordCommand(['--duration', '301'], () => {})).rejects.toThrow(
      /--duration must be/
    );
    await expect(
      runRecordCommand(['--out', 'active/shared/tmp/x.wav'], () => {}, {
        async record() {
          return {};
        },
      })
    ).rejects.toThrow(/unsupported file type/);
    await expect(runRecordCommand(['--bogus'], () => {})).rejects.toThrow(/Unknown option/);
    const output: string[] = [];
    await runRecordCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(RECORD_USAGE);
  });

  it('surfaces actuator failures and unreadable outputs as governed errors', async () => {
    await expect(
      runRecordCommand(['--screen', '--out', 'active/shared/tmp/rec-fail.mp4'], () => {}, {
        async record() {
          throw new Error('no encoder');
        },
      })
    ).rejects.toThrow(/system:record_screen failed: no encoder/);
    await expect(
      runRecordCommand(['--audio', '--out', 'active/shared/tmp/rec-afail.wav'], () => {}, {
        async record() {
          throw new Error('no mic');
        },
      })
    ).rejects.toThrow(/system:record_audio failed: no mic/);
    await expect(
      runRecordCommand(['--screen', '--out', 'active/shared/tmp/rec-missing.mp4'], () => {}, {
        async record() {
          return { status: 'succeeded', context: {} };
        },
      })
    ).rejects.toThrow(/reported success but .* unreadable/);
  });

  it('renders JSON and multi-file summaries explicitly', () => {
    expect(
      renderRecordResult(
        { out: 'a.mp4', bytes: 1, duration_s: 5, source: 'screen', warnings: [] },
        true
      )
    ).toContain('"out": "a.mp4"');
    expect(
      renderRecordResult(
        {
          out: 'd',
          bytes: 2,
          duration_s: 3,
          source: 'audio',
          files: ['d/a.wav', 'd/b.wav'],
          warnings: [],
        },
        false
      )
    ).toContain('2 audio files');
  });
});
