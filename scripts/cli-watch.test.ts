import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import {
  dropDuplicateFrames,
  parseFfprobeMetadata,
  runWatchCommand,
  WATCH_USAGE,
} from './cli-watch.js';
import { createFakeDeps, fakeBridge } from './lib/perception.test-support.js';

const PROBE_WITH_AUDIO = JSON.stringify({
  format: { duration: '30.0' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});
const PROBE_SILENT = JSON.stringify({
  format: { duration: '4.0' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
});

describe('pnpm kyberion watch', () => {
  let workDir = '';
  let videoPath = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-watch-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    videoPath = path.join(workDir, 'demo.mp4');
    safeWriteFile(videoPath, Buffer.from('fake-video'));
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('prints metadata, transcript and a de-duplicated OCR timeline, then cleans scratch', async () => {
    const texts = ['Title slide', 'Title  slide', 'Agenda'];
    const deps = createFakeDeps({
      ffprobe: PROBE_WITH_AUDIO,
      frameCount: 3,
      ocrText: (p) => texts[Number(/frame-(\d{4})/.exec(p)![1]) - 1]!,
      bridges: [
        fakeBridge('seg', { text: 'hi', segments: [{ start_sec: 1, end_sec: 3, text: 'hi' }] }),
      ],
    });
    const output: string[] = [];
    const result = await runWatchCommand(
      [path.relative(pathResolver.rootDir(), videoPath), '--every', '10'],
      (t) => output.push(t),
      deps
    );
    const printed = output.join('\n');
    expect(printed).toContain('- resolution: 1280×720 (h264)');
    expect(printed).toContain('## Transcript');
    expect(printed).toContain('[00:01–00:03] hi');
    expect(printed).toContain('### 00:00\n\nTitle slide');
    expect(printed).not.toContain('### 00:10');
    expect(printed).toContain('### 00:20\n\nAgenda');
    expect(printed).toContain('> [watch] 1 near-duplicate frame(s) omitted');
    expect(result?.frames.map((f) => f.time_sec)).toEqual([0, 20]);
    const frameCall = deps.calls.find((c) => c.tool === 'ffmpeg' && c.args.includes('-vf'))!;
    expect(frameCall.args).toEqual(expect.arrayContaining(['fps=1/10', '-frames:v', '24']));
    const scratch = path.dirname(path.dirname(frameCall.args[frameCall.args.length - 1]!));
    expect(scratch.startsWith(pathResolver.sharedTmp())).toBe(true);
    expect(safeExistsSync(scratch)).toBe(false);
  });

  it('spreads --max-frames over the duration by default and keeps frames with --frames', async () => {
    const framesDir = path.join(workDir, 'kept');
    const deps = createFakeDeps({ ffprobe: PROBE_SILENT, frameCount: 2 });
    const output: string[] = [];
    const result = await runWatchCommand(
      [videoPath, '--max-frames', '2', '--frames', framesDir, '--no-ocr'],
      (t) => output.push(t),
      deps
    );
    expect(result?.every_sec).toBe(2);
    expect(safeReaddir(framesDir).sort()).toEqual(['frame-0001.png', 'frame-0002.png']);
    const printed = output.join('\n');
    expect(printed).toContain(
      `frame: ${path.relative(pathResolver.rootDir(), path.join(framesDir, 'frame-0001.png'))}`
    );
    expect(printed).toContain('> [watch] video has no audio stream; no transcript');
    expect(printed).toContain('> [watch] sampling capped at 2 frames');
    expect(deps.ocrPaths).toEqual([]);
  });

  it('warns (does not fail) when no speech backend is installed', async () => {
    const output: string[] = [];
    await runWatchCommand(
      [videoPath],
      (t) => output.push(t),
      createFakeDeps({ ffprobe: PROBE_WITH_AUDIO })
    );
    expect(output.join('\n')).toMatch(
      /> \[watch\] no transcript: no speech-to-text backend[\s\S]*voice setup/
    );
  });

  it('turns a missing ffmpeg into the install instruction', async () => {
    await expect(
      runWatchCommand([videoPath], () => {}, createFakeDeps({ missingFfmpeg: true }))
    ).rejects.toThrow(/brew install ffmpeg/);
  });

  it('refuses outside-repo input and frames dirs, unsupported types, bad numbers, and prints usage', async () => {
    await expect(
      runWatchCommand(['/Users/someone/Downloads/a.mp4'], () => {}, createFakeDeps())
    ).rejects.toThrow(/outside the repository[\s\S]*active\/shared\/tmp/);
    await expect(
      runWatchCommand([videoPath, '--frames', '/Users/someone/frames'], () => {}, createFakeDeps())
    ).rejects.toThrow(/--frames .* must be a directory inside the repository/);
    await expect(
      runWatchCommand([path.join(workDir, 'a.wav')], () => {}, createFakeDeps())
    ).rejects.toThrow(/unsupported file type[\s\S]*kyberion listen/);
    await expect(
      runWatchCommand([videoPath, '--every', '0'], () => {}, createFakeDeps())
    ).rejects.toThrow(/--every requires a positive number/);
    await expect(runWatchCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion watch/);
    const output: string[] = [];
    await runWatchCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(WATCH_USAGE);
  });

  it('parses ffprobe JSON and drops only consecutive near-duplicates', () => {
    expect(parseFfprobeMetadata(PROBE_SILENT)).toEqual({
      duration_sec: 4,
      width: 320,
      height: 240,
      video_codec: 'h264',
      has_audio: false,
    });
    const frames = [
      { time_sec: 0, text: 'A' },
      { time_sec: 1, text: 'B' },
      { time_sec: 2, text: 'A' },
    ];
    expect(dropDuplicateFrames(frames)).toHaveLength(3);
  });
});
