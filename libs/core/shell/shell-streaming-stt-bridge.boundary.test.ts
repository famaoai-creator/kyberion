import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStreamingSttBridge,
  listStreamingSttBridges,
  resetStreamingSttBridges,
} from '../voice/streaming-stt-bridge.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import {
  installShellStreamingSttBridgeFromEnv,
  parseShellStreamingSttTranscript,
  ShellStreamingSpeechToTextBridge,
} from './shell-streaming-stt-bridge.js';
import type { AudioChunk } from '../meeting/meeting-session-types.js';

async function* noAudio(): AsyncIterable<AudioChunk> {}

function shellBridge(script: string, env?: Record<string, string>) {
  return new ShellStreamingSpeechToTextBridge({
    bridge_id: 'test-shell',
    command: process.execPath,
    args: ['-e', script],
    env,
  });
}

async function waitForExit(pid: number) {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 5000 }
    )
    .toBe(true);
}

async function transcripts(stream: AsyncIterable<{ text: string }>) {
  const result: string[] = [];
  for await (const chunk of stream) result.push(chunk.text);
  return result;
}

describe('shell streaming STT subprocess lifecycle', () => {
  it('drains queued transcripts and a final line without a newline after the child closes', async () => {
    const bridge = shellBridge(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        const lines = [String(process.pid), 'second', 'last'].map(text => JSON.stringify({text}));
        process.stdout.write(lines.join('\\n'));
      });
    `);
    const stream = bridge.transcribeStream(noAudio())[Symbol.asyncIterator]();
    try {
      const first = await stream.next();
      await waitForExit(Number(first.value!.text));
      expect((await stream.next()).value?.text).toBe('second');
      expect((await stream.next()).value?.text).toBe('last');
      expect((await stream.next()).done).toBe(true);
    } finally {
      await stream.return?.();
    }
  });

  it('rejects a nonzero exit while waiting for a transcript', async () => {
    await expect(
      transcripts(shellBridge('process.exit(7)').transcribeStream(noAudio()))
    ).rejects.toThrow(/shell STT exited with code 7/);
  });

  it('reports a nonzero exit even after yielding transcripts to a slow consumer', async () => {
    const stream = shellBridge(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({text:String(process.pid)})+'\\n', () => process.exit(7));
      });
    `)
      .transcribeStream(noAudio())
      [Symbol.asyncIterator]();
    try {
      const first = await stream.next();
      await waitForExit(Number(first.value!.text));
      await expect(stream.next()).rejects.toThrow(/shell STT exited with code 7/);
    } finally {
      await stream.return?.();
    }
  });

  it('rejects a spawn failure', async () => {
    const bridge = new ShellStreamingSpeechToTextBridge({
      bridge_id: 'missing',
      command: '/nonexistent/kyberion-stt-worker',
    });
    await expect(transcripts(bridge.transcribeStream(noAudio()))).rejects.toThrow(/ENOENT/);
  });

  it('propagates an audio input failure without an unhandled rejection', async () => {
    async function* brokenAudio(): AsyncIterable<AudioChunk> {
      throw new Error('audio input failed');
    }
    await expect(
      transcripts(shellBridge('process.stdin.resume()').transcribeStream(brokenAudio()))
    ).rejects.toThrow('audio input failed');
  });

  it('forwards the requested language per call and preserves the configured default', async () => {
    const bridge = shellBridge(
      `
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write(JSON.stringify({text:process.env.KYBERION_STT_LANGUAGE})+'\\n'));
    `,
      { KYBERION_STT_LANGUAGE: 'ja' }
    );
    expect(await transcripts(bridge.transcribeStream(noAudio(), { language: 'en-US' }))).toEqual([
      'en',
    ]);
    expect(await transcripts(bridge.transcribeStream(noAudio()))).toEqual(['ja']);
  });
});

describe('shell streaming STT transcript boundary', () => {
  it('routes Shell streaming STT environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/shell/shell-streaming-stt-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('maps a valid object into a transcript chunk', () => {
    const chunk = parseShellStreamingSttTranscript(
      '{"utterance_id":"u1","is_final":true,"text":"こんにちは","confidence":0.92,"speaker_label":"operator"}'
    );

    expect(chunk).toMatchObject({
      utterance_id: 'u1',
      is_final: true,
      text: 'こんにちは',
      confidence: 0.92,
      speaker_label: 'operator',
    });
    expect(chunk?.emitted_at).toBeTruthy();
  });

  it('rejects arrays and dangerous JSON keys before event creation', () => {
    expect(() => parseShellStreamingSttTranscript('[]')).toThrow(/must be a JSON object/);
    expect(() => parseShellStreamingSttTranscript('{"__proto__":{"text":"injected"}}')).toThrow(
      /dangerous JSON key/
    );
  });

  it('preserves the bridge defaults for a safe empty object', () => {
    const chunk = parseShellStreamingSttTranscript('{}');
    expect(chunk).toMatchObject({ is_final: true, text: '' });
    expect(chunk?.utterance_id).toBeTruthy();
  });
});

describe('shell streaming STT invocation installation', () => {
  afterEach(() => {
    resetStreamingSttBridges();
    vi.unstubAllEnvs();
  });

  it('uses explicit command arguments and releases only its registration', async () => {
    const script = 'process.stdout.write(JSON.stringify({text:process.argv[1]})+"\\n")';
    const installed = installShellStreamingSttBridgeFromEnv({
      KYBERION_STT_COMMAND: process.execPath,
      KYBERION_STT_ARGS: '-e,' + script + ',explicit-stream',
    });
    expect(installed.installed).toBe(true);
    expect(await transcripts(getStreamingSttBridge('shell').transcribeStream(noAudio()))).toEqual([
      'explicit-stream',
    ]);
    installed.dispose?.();
    expect(listStreamingSttBridges()).not.toContain('shell');
  });

  it('does not borrow a global command when an isolated environment is empty', () => {
    vi.stubEnv('KYBERION_STT_COMMAND', 'ambient-batch-command');
    expect(installShellStreamingSttBridgeFromEnv({}).installed).toBe(false);
    expect(process.env.KYBERION_STT_COMMAND).toBe('ambient-batch-command');
  });
});
