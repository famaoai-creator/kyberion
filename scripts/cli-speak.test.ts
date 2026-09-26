import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { MAX_SPEAK_CHARS, runSpeakCommand, SPEAK_USAGE, type SpeakDeps } from './cli-speak.js';
import type { MediaTool } from './lib/perception.js';

interface FakeSpeakDeps extends SpeakDeps {
  actions: Record<string, unknown>[];
  media: { tool: MediaTool; args: string[] }[];
}

/** Hermetic TTS: no voice engine, audio device, or ffmpeg is touched. */
function createFakeSpeakDeps(
  options: { fail?: string; warnings?: string[]; writeNothing?: boolean } = {}
): FakeSpeakDeps {
  const actions: Record<string, unknown>[] = [];
  const media: { tool: MediaTool; args: string[] }[] = [];
  return {
    actions,
    media,
    async voice(input) {
      actions.push(input);
      if (options.fail) return { status: 'error', message: options.fail };
      if (input.action === 'speak_local') {
        const params = input.params as Record<string, unknown>;
        return {
          status: 'succeeded',
          resolved_engine_id: 'fake_say',
          voice: params.voice ?? 'Kyoko',
          language: params.language ?? 'ja',
          ...(options.warnings ? { warnings: options.warnings } : {}),
        };
      }
      const delivery = input.delivery as { artifact_path: string };
      if (!options.writeNothing) safeWriteFile(delivery.artifact_path, Buffer.from('FORMAIFF'));
      return {
        status: 'succeeded',
        resolved_engine_id: 'fake_say',
        artifact_refs: [delivery.artifact_path],
        ...(options.warnings ? { warnings: options.warnings } : {}),
      };
    },
    async runMedia(tool, args) {
      media.push({ tool, args });
      safeWriteFile(args[args.length - 1]!, Buffer.from('transcoded'));
      return '';
    },
    async voiceDefaults() {
      return { profileId: 'operator-ja-default', voice: 'Kyoko' };
    },
  };
}

describe('pnpm kyberion speak', () => {
  let workDir = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-speak-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('plays through voice:speak_local with local-only engines and the given voice / lang / rate', async () => {
    const deps = createFakeSpeakDeps({ warnings: ['engine fallback'] });
    const output: string[] = [];
    const result = await runSpeakCommand(
      ['hello', 'world', '--voice', 'Samantha', '--lang', 'en', '--rate', '180'],
      (t) => output.push(t),
      deps
    );
    expect(deps.actions).toEqual([
      {
        action: 'speak_local',
        params: {
          text: 'hello world',
          local_only: true,
          language: 'en',
          voice: 'Samantha',
          rate: 180,
        },
      },
    ]);
    expect(result).toMatchObject({ backend: 'fake_say', voice: 'Samantha', out: null });
    expect(output.join('\n')).toBe(
      '[speak] spoke (fake_say, voice Samantha)\n> [speak] engine fallback'
    );
  });

  it('renders into a shared-tmp scratch dir, copies to --out, and removes the scratch dir', async () => {
    const deps = createFakeSpeakDeps();
    const out = path.join(workDir, 'nested', 'hello.aiff');
    const output: string[] = [];
    const result = await runSpeakCommand(
      ['こんにちは', '--out', out, '--voice', 'Otoya'],
      (t) => output.push(t),
      deps
    );
    const action = deps.actions[0]!;
    expect(action).toMatchObject({
      action: 'generate_voice',
      text: 'こんにちは',
      profile_ref: { profile_id: 'operator-ja-default' },
      engine: { engine_id: 'auto', local_only: true },
      rendering: { language: 'ja' },
      delivery: { mode: 'artifact', format: 'aiff' },
    });
    const scratch = path.dirname((action.delivery as { artifact_path: string }).artifact_path);
    expect(scratch.startsWith(pathResolver.sharedTmp())).toBe(true);
    expect(safeExistsSync(scratch)).toBe(false);
    expect(String(safeReadFile(out, { encoding: 'utf8' }))).toBe('FORMAIFF');
    expect(deps.media).toEqual([]);
    const rel = path.relative(pathResolver.rootDir(), out);
    expect(result).toMatchObject({ backend: 'fake_say', out: rel, bytes: 8, language: 'ja' });
    expect(output.join('\n')).toContain(`[speak] wrote ${rel} (fake_say, 8 bytes)`);
    expect(output.join('\n')).toContain('> [speak] --voice/--rate apply to playback only');
  });

  it('transcodes .m4a / .mp3 with ffmpeg from a wav render and prints JSON', async () => {
    const deps = createFakeSpeakDeps();
    const out = path.join(workDir, 'hello.m4a');
    const output: string[] = [];
    await runSpeakCommand(['hi', '--out', out, '--json'], (t) => output.push(t), deps);
    expect((deps.actions[0]!.delivery as { format: string }).format).toBe('wav');
    expect(deps.media[0]!.tool).toBe('ffmpeg');
    expect(deps.media[0]!.args).toEqual(expect.arrayContaining(['-c:a', 'aac', out]));
    expect(JSON.parse(output.join('\n'))).toEqual({
      backend: 'fake_say',
      voice: 'Kyoko',
      language: 'en',
      out: path.relative(pathResolver.rootDir(), out),
      bytes: 10,
      warnings: [],
    });
  });

  it('reads the text from --file inside the repository', async () => {
    const file = path.join(workDir, 'script.txt');
    safeWriteFile(file, '  from a file \n');
    const deps = createFakeSpeakDeps();
    await runSpeakCommand(['--file', path.relative(pathResolver.rootDir(), file)], () => {}, deps);
    expect((deps.actions[0]!.params as { text: string }).text).toBe('from a file');
  });

  it('refuses outside-repo --file / --out, bad extensions, empty and oversized text', async () => {
    const deps = createFakeSpeakDeps();
    await expect(
      runSpeakCommand(['--file', '/Users/someone/Downloads/a.txt'], () => {}, deps)
    ).rejects.toThrow(/outside the repository[\s\S]*active\/shared\/tmp/);
    await expect(
      runSpeakCommand(['hi', '--out', '/Users/someone/Desktop/a.wav'], () => {}, deps)
    ).rejects.toThrow(/--out \/Users\/someone\/Desktop\/a.wav must be inside the repository/);
    await expect(
      runSpeakCommand(['hi', '--out', path.join(workDir, 'a.txt')], () => {}, deps)
    ).rejects.toThrow(/unsupported file type "\.txt"/);
    await expect(runSpeakCommand(['   '], () => {}, deps)).rejects.toThrow(/text is empty/);
    const empty = path.join(workDir, 'empty.txt');
    safeWriteFile(empty, '\n');
    await expect(runSpeakCommand(['--file', empty], () => {}, deps)).rejects.toThrow(
      /text is empty/
    );
    await expect(
      runSpeakCommand(['a'.repeat(MAX_SPEAK_CHARS + 1)], () => {}, deps)
    ).rejects.toThrow(new RegExp(`limit is ${MAX_SPEAK_CHARS}`));
    await expect(runSpeakCommand(['hi', '--file', empty], () => {}, deps)).rejects.toThrow(
      /not both/
    );
    await expect(runSpeakCommand(['hi', '--rate', 'fast'], () => {}, deps)).rejects.toThrow(
      /--rate must be a number/
    );
    await expect(runSpeakCommand(['hi', '--bogus'], () => {}, deps)).rejects.toThrow(
      /Unknown option: --bogus/
    );
    expect(deps.actions).toEqual([]);
  });

  it('surfaces voice actuator failures and missing artifacts, and still cleans up', async () => {
    await expect(
      runSpeakCommand(['hi'], () => {}, createFakeSpeakDeps({ fail: 'no engine' }))
    ).rejects.toThrow('[speak] voice:speak_local failed: no engine');
    const deps = createFakeSpeakDeps({ writeNothing: true });
    await expect(
      runSpeakCommand(['hi', '--out', path.join(workDir, 'x.wav')], () => {}, deps)
    ).rejects.toThrow(/wrote no audio/);
    const scratch = path.dirname(
      (deps.actions[0]!.delivery as { artifact_path: string }).artifact_path
    );
    expect(safeExistsSync(scratch)).toBe(false);
  });

  it('prints usage', async () => {
    await expect(runSpeakCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion speak/);
    const output: string[] = [];
    await runSpeakCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(SPEAK_USAGE);
  });
});
