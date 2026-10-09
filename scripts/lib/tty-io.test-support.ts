import { PassThrough, Writable } from 'node:stream';
import { cliTtyIoTestSeam, type CliTtyIo } from './cli-tty-io.js';

/**
 * Test support: an interactive terminal for the approval TTY challenge. When
 * the challenge prints its one-time code, `answer(code)` is typed back; an
 * answer of `null` types nothing (the operator walked away).
 */
export function ttyIo(answer: (code: string) => string | null): CliTtyIo {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  let printed = '';
  let answered = false;
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        printed += String(chunk);
        const match = /Type ([0-9a-f]{6}) to approve/.exec(printed);
        if (match && !answered) {
          answered = true;
          const typed = answer(match[1]!);
          if (typed !== null) stdin.write(`${typed}\n`);
        }
        callback();
      },
    }),
    { isTTY: true }
  );
  return { stdin, stdout };
}

/** Points the challenge at `io` (and optionally a short timeout) until `resetTtyIo`. */
export function useTtyIo(io: CliTtyIo, options: { timeoutMs?: number } = {}): void {
  cliTtyIoTestSeam.io = io;
  if (options.timeoutMs !== undefined) cliTtyIoTestSeam.timeoutMs = options.timeoutMs;
}

export function resetTtyIo(): void {
  delete cliTtyIoTestSeam.io;
  delete cliTtyIoTestSeam.timeoutMs;
}

/** Runs `fn` with an interactive terminal that answers the challenge with `answer`. */
export async function withTtyAnswer<T>(
  answer: (code: string) => string | null,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  useTtyIo(ttyIo(answer), options);
  try {
    return await fn();
  } finally {
    resetTtyIo();
  }
}
