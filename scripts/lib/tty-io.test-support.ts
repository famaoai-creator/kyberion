import { PassThrough, Writable } from 'node:stream';
import {
  clearCliTtyIoTestSeam,
  installCliTtyIoTestSeam,
  type CliTerminalEvidence,
  type CliTtyIo,
} from './cli-tty-io.js';

/** The runner's real lineage is often a provider CLI; tests see a neutral one unless they ask. */
const NEUTRAL_TERMINAL_EVIDENCE: CliTerminalEvidence = { osUser: 'vitest', tty: null, lineage: [] };

type EvidenceChoice = CliTerminalEvidence | 'probe';
let evidenceOverride: EvidenceChoice | undefined;

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
        const match = /Type ([0-9a-f]{6}) to (?:approve|reject)/.exec(printed);
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

/**
 * Points the challenge at `io` (and optionally a short timeout) until
 * `resetTtyIo`. Terminal evidence is neutral unless `evidence` says otherwise;
 * `'probe'` leaves it uninstalled so the real `ps` probe runs.
 */
export function useTtyIo(
  io: CliTtyIo,
  options: { timeoutMs?: number; evidence?: EvidenceChoice } = {}
): void {
  const evidence = options.evidence ?? evidenceOverride ?? NEUTRAL_TERMINAL_EVIDENCE;
  installCliTtyIoTestSeam({
    io,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // 'probe' drops any evidence installed earlier, so the real `ps` probe runs.
    evidence: evidence === 'probe' ? undefined : evidence,
  });
}

export function resetTtyIo(): void {
  evidenceOverride = undefined;
  clearCliTtyIoTestSeam();
}

/**
 * What the terminal attestation records as OS user, tty and parent lineage
 * (until `resetTtyIo`); `'probe'` runs the real `ps` probe.
 */
export function useTerminalEvidence(evidence: EvidenceChoice): void {
  evidenceOverride = evidence;
  installCliTtyIoTestSeam({ evidence: evidence === 'probe' ? undefined : evidence });
}

/** Runs `fn` with an interactive terminal that answers the challenge with `answer`. */
export async function withTtyAnswer<T>(
  answer: (code: string) => string | null,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; evidence?: EvidenceChoice } = {}
): Promise<T> {
  useTtyIo(ttyIo(answer), options);
  try {
    return await fn();
  } finally {
    resetTtyIo();
  }
}
