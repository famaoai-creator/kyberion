import { PassThrough, Writable } from 'node:stream';
import type { CliTtyIo } from './approval-cli-decision.js';

/**
 * Test support: an interactive terminal for the approval TTY challenge. When
 * the challenge prints its one-time code, `answer(code)` is typed back.
 */
export function ttyIo(answer: (code: string) => string): CliTtyIo {
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
          stdin.write(`${answer(match[1]!)}\n`);
        }
        callback();
      },
    }),
    { isTTY: true }
  );
  return { stdin, stdout };
}
