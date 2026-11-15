/**
 * Bounded raw TTY collector. It never attaches an echoing readline interface.
 * The first newline confirms one token; remaining bytes in that event are
 * discarded rather than interpreted as another token or command.
 */
import { StringDecoder } from 'node:string_decoder';

export const HIDDEN_TOKEN_TIMEOUT_MS = 120_000;
export const HIDDEN_TOKEN_MAX_BYTES = 16 * 1024;
type Input = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?: (raw: boolean) => unknown;
  isPaused(): boolean;
  pause(): unknown;
  resume(): unknown;
};
type Output = Pick<NodeJS.WritableStream, 'write'> & { isTTY?: boolean };
type Signals = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/** Injected streams and deadlines support unit tests; the CLI uses only process defaults. */
export function readHiddenToken(
  prompt: string,
  options: {
    input?: Input;
    output?: Output;
    timeoutMs?: number;
    maxBytes?: number;
    signals?: Signals;
  } = {}
): Promise<string> {
  const input: Input = options.input ?? process.stdin;
  const output: Output = options.output ?? process.stderr;
  const signals: Signals = options.signals ?? process;
  const timeoutMs = options.timeoutMs ?? HIDDEN_TOKEN_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? HIDDEN_TOKEN_MAX_BYTES;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(
      new Error('[ACCOUNT_CLI] An interactive terminal is required for token entry.')
    );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > HIDDEN_TOKEN_TIMEOUT_MS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > HIDDEN_TOKEN_MAX_BYTES
  )
    return Promise.reject(new Error('[ACCOUNT_CLI] Invalid token collection limits.'));
  if (input.listenerCount('data') > 0 || input.listenerCount('readable') > 0)
    return Promise.reject(new Error('[ACCOUNT_CLI] Terminal input is already in use.'));
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing === true;
    const decoder = new StringDecoder('utf8');
    let value = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.removeListener('data', data);
      input.removeListener('end', eof);
      input.removeListener('close', eof);
      input.removeListener('error', failed);
      signals.removeListener('SIGINT', cancelled);
      signals.removeListener('SIGTERM', cancelled);
      let restoreFailed = false;
      try {
        input.setRawMode!(wasRaw);
      } catch {
        restoreFailed = true;
      }
      try {
        if (!wasFlowing) input.pause();
      } catch {
        restoreFailed = true;
      }
      try {
        output.write('\n');
      } catch {
        restoreFailed = true;
      }
      const collected = value;
      value = '';
      if (error || restoreFailed)
        reject(new Error(error ?? '[ACCOUNT_CLI] Terminal restoration failed.'));
      else resolve(collected);
    };
    const eof = () => end('[ACCOUNT_CLI] Token entry ended without confirmation.');
    const failed = () => end('[ACCOUNT_CLI] Terminal input failed.');
    const cancelled = () => end('[ACCOUNT_CLI] Token entry cancelled.');
    const data = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (character === '\u0003') return cancelled();
        if (character === '\u0004') return eof();
        if (character === '\n' || character === '\r')
          return end(value ? undefined : '[ACCOUNT_CLI] Empty token refused.');
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        // Escape sequences, tabs and controls are never part of a token.
        if (/[\u0000-\u001f\u007f]/u.test(character))
          return end('[ACCOUNT_CLI] Token contains a control character.');
        value += character;
        if (Buffer.byteLength(value, 'utf8') > maxBytes)
          return end('[ACCOUNT_CLI] Token exceeds the size limit.');
      }
    };
    try {
      input.setRawMode!(true);
      input.on('data', data);
      input.once('end', eof);
      input.once('close', eof);
      input.once('error', failed);
      signals.once('SIGINT', cancelled);
      signals.once('SIGTERM', cancelled);
      timer = setTimeout(() => end('[ACCOUNT_CLI] Token entry timed out.'), timeoutMs);
      output.write(prompt);
      input.resume();
    } catch {
      failed();
    }
  });
}
