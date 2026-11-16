/** Explicit private token transport; possession still requires normal authentication. */
import type { Readable } from 'node:stream';
import { safeOpenInheritedTokenPipe } from '@agent/core/secure-io';

export const PRIVATE_TOKEN_PIPE_TIMEOUT_MS = 120_000;
export const PRIVATE_TOKEN_PIPE_MAX_BYTES = 16 * 1024;
type Signals = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/** Destroy can report an asynchronous error; retain an absorber until closure. */
function destroyPrivateInput(input: Readable): void {
  if (input.closed) return;
  const absorb = () => {};
  input.on('error', absorb);
  input.once('close', () => input.removeListener('error', absorb));
  try {
    input.destroy();
  } catch {
    /* Never expose a transport implementation error. */
  }
}

/** The CLI always owns fixed FD 3; injected streams and shorter deadlines are test seams. */
export function readPrivateTokenPipe(
  options: {
    input?: Readable;
    timeoutMs?: number;
    signals?: Signals;
  } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? PRIVATE_TOKEN_PIPE_TIMEOUT_MS;
  const signals = options.signals ?? process;
  const started = performance.now();
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PRIVATE_TOKEN_PIPE_TIMEOUT_MS
  ) {
    if (options.input) destroyPrivateInput(options.input);
    return Promise.reject(new Error('[ACCOUNT_CLI] Invalid private token deadline.'));
  }
  let input: Readable;
  try {
    input = options.input ?? safeOpenInheritedTokenPipe();
  } catch {
    return Promise.reject(new Error('[ACCOUNT_CLI] Private token pipe unavailable.'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.removeListener('data', data);
      input.removeListener('end', eof);
      input.removeListener('close', closed);
      input.removeListener('error', failed);
      signals.removeListener('SIGINT', cancelled);
      signals.removeListener('SIGTERM', cancelled);
      const token = value;
      value = '';
      destroyPrivateInput(input);
      if (error) reject(new Error(error));
      else resolve(token.endsWith('\n') ? token.slice(0, -1) : token);
    };
    const failed = () => finish('[ACCOUNT_CLI] Private token pipe failed.');
    const cancelled = () => finish('[ACCOUNT_CLI] Private token input cancelled.');
    const closed = () => finish('[ACCOUNT_CLI] Private token pipe closed before EOF.');
    const eof = () => {
      if (performance.now() - started >= timeoutMs)
        return finish('[ACCOUNT_CLI] Private token input timed out.');
      if (!/^kya1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n?$/.test(value))
        return finish('[ACCOUNT_CLI] Private token frame invalid.');
      finish();
    };
    const data = (chunk: Buffer | string) => {
      if (performance.now() - started >= timeoutMs)
        return finish('[ACCOUNT_CLI] Private token input timed out.');
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += buffer.length;
      if (bytes > PRIVATE_TOKEN_PIPE_MAX_BYTES)
        return finish('[ACCOUNT_CLI] Private token exceeds the size limit.');
      if (buffer.some((byte) => byte > 0x7f || (byte < 0x20 && byte !== 0x0a) || byte === 0x7f))
        return finish('[ACCOUNT_CLI] Private token frame invalid.');
      value += buffer.toString('ascii');
      // An LF is permitted only as the single final byte; still wait for EOF.
      const newline = value.indexOf('\n');
      if (newline !== -1 && newline !== value.length - 1)
        finish('[ACCOUNT_CLI] Private token frame invalid.');
    };
    try {
      if (
        input.destroyed ||
        input.readableEnded ||
        input.listenerCount('data') ||
        input.listenerCount('readable')
      ) {
        finish('[ACCOUNT_CLI] Private token pipe is already in use or closed.');
        return;
      }
      input.on('data', data);
      input.once('end', eof);
      input.once('close', closed);
      input.once('error', failed);
      signals.once('SIGINT', cancelled);
      signals.once('SIGTERM', cancelled);
      timer = setTimeout(() => finish('[ACCOUNT_CLI] Private token input timed out.'), timeoutMs);
      input.resume();
    } catch {
      failed();
    }
  });
}
