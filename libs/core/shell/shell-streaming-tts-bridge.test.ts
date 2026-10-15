import { describe, expect, it } from 'vitest';
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
