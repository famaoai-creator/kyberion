import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { stubSpeechToTextBridge } from '@agent/core/speech-to-text-bridge';
import { LISTEN_USAGE, runListenCommand } from './cli-listen.js';
import { createFakeDeps, fakeBridge } from './lib/perception.test-support.js';

describe('pnpm kyberion listen', () => {
  let workDir = '';
  let audioPath = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-listen-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    audioPath = path.join(workDir, 'memo.m4a');
    safeWriteFile(audioPath, Buffer.from('fake-audio'));
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('normalizes to 16k mono wav in shared tmp, transcribes, and leaves nothing next to the input', async () => {
    const seen: string[] = [];
    const deps = createFakeDeps({
      bridges: [fakeBridge('fake-stt', { text: 'hello world' }, seen)],
    });
    const output: string[] = [];
    const result = await runListenCommand(
      [path.relative(pathResolver.rootDir(), audioPath), '--lang', 'en'],
      (t) => output.push(t),
      deps
    );
    expect(result?.text).toBe('hello world');
    const ffmpeg = deps.calls[0]!;
    expect(ffmpeg.tool).toBe('ffmpeg');
    expect(ffmpeg.args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', audioPath]));
    const scratch = path.dirname(seen[0]!);
    expect(scratch.startsWith(pathResolver.sharedTmp())).toBe(true);
    expect(path.dirname(seen[1]!)).toBe(scratch);
    expect(safeExistsSync(scratch)).toBe(false); // cleaned up
    expect(safeReaddir(workDir)).toEqual(['memo.m4a']);
    expect(output.join('\n')).toContain(
      '- backend: fake-stt (language en)\n\n## Transcript\n\nhello world'
    );
  });

  it('renders [mm:ss–mm:ss] segments with --timestamps, preferring a timestamp-capable backend', async () => {
    const deps = createFakeDeps({
      bridges: [
        { ...fakeBridge('plain', { text: 'plain' }), priority: 99 },
        fakeBridge('segmented', {
          text: 'a b',
          segments: [
            { start_sec: 0, end_sec: 2.5, text: 'a' },
            { start_sec: 65, end_sec: 70, text: 'b' },
          ],
        }),
      ],
    });
    const output: string[] = [];
    await runListenCommand([audioPath, '--timestamps'], (t) => output.push(t), deps);
    expect(output.join('\n')).toContain('[00:00–00:02] a\n[01:05–01:10] b');
  });

  it('warns when --timestamps is asked but the backend has none', async () => {
    const output: string[] = [];
    await runListenCommand(
      [audioPath, '--timestamps'],
      (t) => output.push(t),
      createFakeDeps({ bridges: [fakeBridge('plain', { text: 'plain' })] })
    );
    expect(output.join('\n')).toContain('> [listen] backend plain returned no timestamps');
  });

  it('fails with the voice setup hint instead of printing stub or synthetic text', async () => {
    await expect(
      runListenCommand([audioPath], () => {}, createFakeDeps({ bridges: [stubSpeechToTextBridge] }))
    ).rejects.toThrow(/no speech-to-text backend[\s\S]*kyberion voice setup/);
    await expect(
      runListenCommand(
        [audioPath],
        () => {},
        createFakeDeps({ bridges: [fakeBridge('sidecar', { text: 'fake', synthetic: true })] })
      )
    ).rejects.toThrow(/synthetic[\s\S]*kyberion voice setup/);
  });

  it('turns a missing ffmpeg into the install instruction', async () => {
    await expect(
      runListenCommand(
        [audioPath],
        () => {},
        createFakeDeps({ missingFfmpeg: true, bridges: [fakeBridge('x', { text: 'x' })] })
      )
    ).rejects.toThrow(/brew install ffmpeg/);
  });

  it('writes JSON with --out', async () => {
    const out = path.join(workDir, 'memo.json');
    await runListenCommand(
      [audioPath, '--json', '--out', out],
      () => {},
      createFakeDeps({ bridges: [fakeBridge('j', { text: 'json me' })] })
    );
    expect(JSON.parse(String(safeReadFile(out, { encoding: 'utf8' })))).toMatchObject({
      backend: 'j',
      text: 'json me',
    });
    safeRmSync(out, { force: true });
  });

  it('refuses outside-repo files, videos, unsupported types, and prints usage', async () => {
    await expect(
      runListenCommand(['/Users/someone/Downloads/memo.m4a'], () => {}, createFakeDeps())
    ).rejects.toThrow(/outside the repository[\s\S]*active\/shared\/tmp/);
    const video = path.join(workDir, 'clip.mp4');
    const txt = path.join(workDir, 'notes.txt');
    await expect(runListenCommand([video], () => {}, createFakeDeps())).rejects.toThrow(
      /kyberion watch/
    );
    await expect(runListenCommand([txt], () => {}, createFakeDeps())).rejects.toThrow(
      /unsupported file type/
    );
    await expect(runListenCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion listen/);
    const output: string[] = [];
    await runListenCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(LISTEN_USAGE);
  });
});
