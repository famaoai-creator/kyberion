import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import { ShellStreamingTextToSpeechBridge } from './shell-streaming-tts-bridge.js';

// A framed-protocol worker: per stdin line, emits `framesPerLine` payload
// frames (deterministic byte fill) then a zero-length end-of-request frame.
const FRAMED_WORKER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const frames = Number(process.env.FIXTURE_FRAMES_PER_LINE || 2);
  for (let i = 0; i < frames; i++) {
    const payload = Buffer.alloc(320, (line.charCodeAt(0) + i) & 0xff);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    process.stdout.write(Buffer.concat([header, payload]));
  }
  const end = Buffer.alloc(4);
  end.writeUInt32BE(0);
  process.stdout.write(end);
});
`;

// Worker that prints a garbage (non-framed) stream — desyncs the parser.
const GARBAGE_WORKER = `
setInterval(() => {}, 1000);
process.stdout.write(Buffer.alloc(4).fill(0xff));
`;

// Worker that emits unframed raw PCM — what a non-framed command looks like
// to a channel expecting the frame protocol.
const RAW_PCM_WORKER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', () => process.stdout.write(Buffer.alloc(4096, 1)));
`;

async function* linesOf(...lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

async function collect(stream: AsyncIterable<{ payload: Uint8Array }>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk.payload);
  return chunks;
}

function bridge(env?: Record<string, string>) {
  return new ShellStreamingTextToSpeechBridge({
    bridge_id: 'test-framed',
    command: process.execPath,
    args: ['-e', FRAMED_WORKER],
    env,
    persistent: true,
  });
}

function ephemeral(worker: string) {
  return new ShellStreamingTextToSpeechBridge({
    bridge_id: 'test-ephemeral',
    command: process.execPath,
    args: ['-e', worker],
  });
}

describe('shell streaming TTS bridge — ephemeral mode', () => {
  it('drains queued PCM after the worker closes while the consumer is paused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input() {
      yield 'first';
      await gate;
      yield 'last';
    }
    const b = ephemeral(`
      const rl = require('readline').createInterface({ input: process.stdin });
      let first = true;
      rl.on('line', () => {
        if (first) {
          first = false;
          const bytes = Buffer.alloc(320);
          bytes.writeUInt32LE(process.pid);
          process.stdout.write(bytes);
        } else {
          process.stdout.end(Buffer.alloc(640, 2), () => process.exit(0));
        }
      });
    `);
    const iter = b.synthesizeStream(input(), 'test')[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    const pid = Buffer.from(first.value!.payload).readUInt32LE();
    release();
    // Wait for actual process termination, without advancing the audio consumer.
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
    let bytes = first.value!.payload.byteLength;
    for (;;) {
      const next = await iter.next();
      if (next.done) break;
      bytes += next.value.payload.byteLength;
    }
    expect(bytes).toBe(960);
  });

  it('rejects a failed worker while waiting for PCM', async () => {
    await expect(
      collect(ephemeral('process.exit(7)').synthesizeStream(linesOf(), 'test'))
    ).rejects.toThrow('code 7');
  });

  it('rejects a failed worker after yielding PCM', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input() {
      yield 'first';
      await gate;
      yield 'last';
    }
    const b = ephemeral(`
      const rl = require('readline').createInterface({ input: process.stdin });
      let first = true;
      rl.on('line', () => {
        if (first) { first = false; process.stdout.write(Buffer.alloc(320)); }
        else process.exit(7);
      });
    `);
    const iter = b.synthesizeStream(input(), 'test')[Symbol.asyncIterator]();
    expect((await iter.next()).done).toBe(false);
    release();
    await expect(iter.next()).rejects.toThrow('code 7');
  });

  it('surfaces spawn errors to a waiting consumer', async () => {
    const b = new ShellStreamingTextToSpeechBridge({
      bridge_id: 'missing',
      command: '/nonexistent-kyberion-tts-worker',
    });
    await expect(collect(b.synthesizeStream(linesOf(), 'test'))).rejects.toThrow(/ENOENT/);
  });

  it('surfaces text source failures and terminates the worker', async () => {
    async function* input(): AsyncGenerator<string> {
      throw new Error('text source failed');
    }
    await expect(
      collect(ephemeral('process.stdin.resume()').synthesizeStream(input(), 'test'))
    ).rejects.toThrow('text source failed');
  });
});

describe('shell streaming TTS bridge — persistent framed mode', () => {
  it('routes environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/shell/shell-streaming-tts-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('serves two sequential calls from one resident worker', async () => {
    const b = bridge();
    const first = await collect(b.synthesizeStream(linesOf('alpha'), 'profile-a'));
    const second = await collect(b.synthesizeStream(linesOf('beta'), 'profile-a'));
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0][0]).toBe('a'.charCodeAt(0));
    expect(second[0][0]).toBe('b'.charCodeAt(0));
  });

  it('closes a call only after every line emitted its end-of-request frame', async () => {
    const b = bridge();
    const chunks = await collect(b.synthesizeStream(linesOf('one', 'two', 'three'), 'profile-a'));
    expect(chunks).toHaveLength(6);
  });

  it('lets the next call proceed after an aborted call — with clean attribution', async () => {
    const b = bridge();
    const stream = b.synthesizeStream(linesOf('first', 'second'), 'profile-a');
    const iter = stream[Symbol.asyncIterator]();
    await iter.next();
    await iter.return?.(undefined);
    const second = await collect(b.synthesizeStream(linesOf('ok'), 'profile-a'));
    // The drained 'first'/'second' frames must not bleed into this call's
    // stream — payloads are 'o'/'p' (fill = first char + frame index).
    expect(second.map((p) => p[0])).toEqual(['o'.charCodeAt(0), 'p'.charCodeAt(0)]);
  });

  it('collapses embedded newlines so they cannot desync the frame count', async () => {
    const b = bridge();
    const chunks = await collect(b.synthesizeStream(linesOf('line one\nline two'), 'profile-a'));
    // Normalised to one wire line → one EOR → the call still completes.
    expect(chunks).toHaveLength(2);
  });

  it('rejects a raw-PCM worker under persistent mode', async () => {
    const bad = new ShellStreamingTextToSpeechBridge({
      bridge_id: 'test-framed-raw',
      command: process.execPath,
      args: ['-e', RAW_PCM_WORKER],
      persistent: true,
    });
    await expect(collect(bad.synthesizeStream(linesOf('x'), 'profile-a'))).rejects.toThrow(
      /oversized|desync|exited|stall/i
    );
  });

  it('rejects calls after dispose', async () => {
    const b = bridge();
    await collect(b.synthesizeStream(linesOf('warmup'), 'profile-a'));
    b.dispose();
    await expect(collect(b.synthesizeStream(linesOf('x'), 'profile-a'))).rejects.toThrow(
      /disposed/
    );
  });

  it('surfaces a dead worker as an error, not silence', async () => {
    const bad = new ShellStreamingTextToSpeechBridge({
      bridge_id: 'test-framed-bad',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      persistent: true,
    });
    await expect(collect(bad.synthesizeStream(linesOf('x'), 'profile-a'))).rejects.toThrow(
      /exited|spawn|error/i
    );
  });

  it('rejects a worker whose output desyncs the frame protocol', async () => {
    const bad = new ShellStreamingTextToSpeechBridge({
      bridge_id: 'test-framed-desync',
      command: process.execPath,
      args: ['-e', GARBAGE_WORKER],
      persistent: true,
    });
    await expect(collect(bad.synthesizeStream(linesOf('x'), 'profile-a'))).rejects.toThrow();
  });
});
