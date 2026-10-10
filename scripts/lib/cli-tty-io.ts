/**
 * The terminal the approval TTY challenge talks to, and how long it waits.
 *
 * Production always uses the process's own stdin/stdout and the fixed
 * timeout: neither is a parameter of `decideApprovalFromCli`. Tests swap them
 * through `cliTtyIoTestSeam`, which is set only from
 * `tty-io.test-support.ts` and honoured only inside a vitest worker.
 */
export interface CliTtyIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
}

/** How long the challenge waits for the typed code before refusing. */
export const CLI_TTY_CHALLENGE_TIMEOUT_MS = 120_000;

/** Test-only seam. Do not set outside `tty-io.test-support.ts`. */
export const cliTtyIoTestSeam: { io?: CliTtyIo; timeoutMs?: number } = {};

export function resolveCliTtyChallengeTerminal(): { io: CliTtyIo; timeoutMs: number } {
  const seam = process.env.VITEST ? cliTtyIoTestSeam : {};
  return {
    io: seam.io ?? { stdin: process.stdin, stdout: process.stdout },
    timeoutMs: seam.timeoutMs ?? CLI_TTY_CHALLENGE_TIMEOUT_MS,
  };
}
