import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, type Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { safeCloseFd, safeOpenAppendFile, safeSpawn, safeUnlinkSync } from '@agent/core/secure-io';
import { PRIVATE_TOKEN_PIPE_MAX_BYTES, readPrivateTokenPipe } from './private-token-pipe.js';

const TOKEN = 'kya1.c3ludGhldGlj.c2lnbmF0dXJl';
function fixture(input = new PassThrough()) {
  const signals = new EventEmitter();
  const options = { input, signals, timeoutMs: 100 };
  const clean = async () => {
    await nextTurn();
    expect(input.destroyed).toBe(true);
    for (const event of ['data', 'end', 'close', 'error'])
      expect(input.listenerCount(event)).toBe(0);
    for (const signal of ['SIGINT', 'SIGTERM']) expect(signals.listenerCount(signal)).toBe(0);
  };
  return { input, signals, options, clean };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('private workload token pipe framing and cleanup', () => {
  it.each(['', '\n'])('requires EOF after a single complete frame (%j)', async (suffix) => {
    const f = fixture();
    let settled = false;
    const result = readPrivateTokenPipe(f.options);
    void result.then(() => {
      settled = true;
    });
    f.input.emit('data', Buffer.from(TOKEN.slice(0, 8)));
    f.input.emit('data', Buffer.from(TOKEN.slice(8) + suffix));
    await Promise.resolve();
    expect(settled).toBe(false);
    f.input.emit('end');
    expect(await result).toBe(TOKEN);
    await f.clean();
  });

  it.each([
    '',
    'not-a-token',
    TOKEN + '\n\n',
    TOKEN + '\n' + TOKEN,
    TOKEN + '\r\n',
    TOKEN + '\0',
    TOKEN + 'é',
    TOKEN + ' ',
  ])('rejects invalid framing without exposing input (%j)', async (frame) => {
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    const check = expect(result).rejects.toThrow(/frame invalid/);
    f.input.emit('data', Buffer.from(frame));
    if (!f.input.destroyed) f.input.emit('end');
    await check;
    await f.clean();
  });

  it('rejects a second frame arriving after a separately delivered newline', async () => {
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(TOKEN + '\n'));
    f.input.emit('data', Buffer.from(TOKEN));
    await expect(result).rejects.toThrow('frame invalid');
    await f.clean();
  });

  it('enforces the total byte bound including the optional newline', async () => {
    const exact = 'kya1.' + 'a'.repeat(PRIVATE_TOKEN_PIPE_MAX_BYTES - 7) + '.b';
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(exact));
    f.input.emit('end');
    expect(await result).toBe(exact);
    await f.clean();
    const large = fixture();
    const refused = readPrivateTokenPipe(large.options);
    large.input.emit('data', Buffer.from(exact));
    large.input.emit('data', Buffer.from('\n'));
    await expect(refused).rejects.toThrow('size limit');
    await large.clean();
  });

  it.each(['close', 'error'])('destroys the input and removes handlers on %s', async (event) => {
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(TOKEN));
    f.input.emit(event, Error('sensitive error must not escape'));
    await expect(result).rejects.toThrow(/closed before EOF|pipe failed/);
    await expect(result).rejects.not.toThrow('sensitive error');
    await f.clean();
  });

  it.each(['SIGINT', 'SIGTERM'])('cancels and closes input on %s', async (signal) => {
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(TOKEN));
    f.signals.emit(signal);
    await expect(result).rejects.toThrow('cancelled');
    await f.clean();
  });

  it('times out even when a complete frame has arrived without EOF', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    const check = expect(result).rejects.toThrow('timed out');
    f.input.emit('data', Buffer.from(TOKEN + '\n'));
    await vi.advanceTimersByTimeAsync(101);
    await check;
    await f.clean();
  });

  it('refuses late EOF even before the deadline timer callback runs', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture();
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(TOKEN));
    clock.mockReturnValue(101);
    f.input.emit('end');
    await expect(result).rejects.toThrow('timed out');
    await f.clean();
  });

  it('contains asynchronous destroy errors after cancellation without exposing buffered input', async () => {
    class DestroyFailure extends PassThrough {
      override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
        void nextTurn().then(() => callback(Error('synthetic-secret-destroy-error')));
      }
    }
    const f = fixture(new DestroyFailure());
    const result = readPrivateTokenPipe(f.options);
    f.input.emit('data', Buffer.from(TOKEN));
    f.signals.emit('SIGTERM');
    await expect(result).rejects.toThrow('cancelled');
    await expect(result).rejects.not.toThrow('synthetic-secret');
    await f.clean();
  });

  it.each([0, -1, 0.5, 120001, Infinity, NaN])(
    'closes input for invalid timeout %s',
    async (timeoutMs) => {
      const f = fixture();
      await expect(readPrivateTokenPipe({ ...f.options, timeoutMs })).rejects.toThrow('deadline');
      await f.clean();
    }
  );
});

// Child execution uses source scripts but @agent/core package exports resolve to
// dist: run the repository build before this subprocess integration suite.
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function childPipe(mode: 'pipe' | 'file' | 'cancel' | 'missing') {
  const target = path.join(root, 'active/shared/tmp', 'private-pipe-test-' + randomUUID());
  const file =
    mode === 'file'
      ? withExecutionContext('sovereign_concierge', () => safeOpenAppendFile(target))
      : undefined;
  const source = `
    import { createHash } from 'node:crypto';
    import { readPrivateTokenPipe } from ${JSON.stringify(new URL('./private-token-pipe.ts', import.meta.url).href)};
    import { safeCloseFd } from '@agent/core/secure-io';
    const pending = readPrivateTokenPipe({ timeoutMs: 2000 });
    ${mode === 'cancel' ? "setImmediate(() => process.emit('SIGTERM'));" : ''}
    let result;
    try { const token = await pending; result = { hash: createHash('sha256').update(token).digest('hex') }; }
    catch (error) { result = { error: error.message }; }
    await new Promise(resolve => setImmediate(resolve));
    let closed;
    ${mode === 'pipe' || mode === 'cancel' ? "closed = false; try { safeCloseFd(3); } catch (error) { closed = error.code === 'EBADF'; }" : ''}
    process.stdout.write(JSON.stringify({ ...result, closed }));
  `;
  const child = withExecutionContext('sovereign_concierge', () =>
    safeSpawn(
      process.execPath,
      ['--import', path.join(root, 'scripts/ts-loader.mjs'), '--input-type=module', '-e', source],
      {
        cwd: root,
        stdio:
          mode === 'missing'
            ? ['ignore', 'pipe', 'pipe']
            : ['ignore', 'pipe', 'pipe', file ?? 'pipe'],
      }
    )
  );
  // The parent owns this pipe too: an early child exit can reset it before
  // write completion. Capture that error, retain the exit assertion, and keep
  // the handler through close so cleanup cannot emit an unhandled error.
  const pipe = child.stdio[3] as Writable | null | undefined;
  const pipeErrors: Error[] = [];
  const pipeFailed = (error: Error) => {
    pipeErrors.push(error);
  };
  pipe?.on('error', pipeFailed);
  pipe?.once('close', () => pipe.removeListener('error', pipeFailed));
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    err += String(chunk);
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    if (mode === 'pipe') pipe!.end(TOKEN + '\n');
    expect(await completion, err).toBe(0);
    if (mode === 'pipe') expect(pipeErrors).toEqual([]);
    expect(out).not.toContain(TOKEN);
    return JSON.parse(out) as { hash?: string; error?: string; closed?: boolean };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    pipe?.destroy();
    if (file !== undefined) {
      safeCloseFd(file);
      withExecutionContext('sovereign_concierge', () => safeUnlinkSync(target));
    }
  }
}

describe('actual inherited private FD 3', () => {
  it('reads an inherited OS pipe to EOF and closes it without printing the token', async () => {
    expect(await childPipe('pipe')).toEqual({
      hash: createHash('sha256').update(TOKEN).digest('hex'),
      closed: true,
    });
  }, 20000);
  it('refuses a regular file inherited on FD 3 without taking ownership', async () => {
    const result = await childPipe('file');
    expect(result.error).toMatch(/unavailable/);
  }, 20000);
  it('rejects a missing inherited descriptor without crashing the child', async () => {
    const result = await childPipe('missing');
    expect(result.error).toMatch(/unavailable/);
  }, 20000);
  it('closes an actual pending inherited pipe when cancelled', async () => {
    const result = await childPipe('cancel');
    expect(result.error).toMatch(/cancelled/);
    expect(result.closed).toBe(true);
  }, 20000);
});
