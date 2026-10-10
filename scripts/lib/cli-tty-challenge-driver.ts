/**
 * Runs a CLI that asks for the approval TTY challenge (`approval-cli-decision.ts`)
 * inside a pseudo-terminal and types back the code it prints — the way a
 * person at a terminal answers it. Used by end-to-end checks that approve a
 * human-only request through the operator CLI.
 *
 * Nothing here bypasses the attestation: the CLI still requires a TTY, still
 * walks its parent processes and refuses under a provider CLI, and records
 * `terminal_attested` only after the typed code matched. Run from an agent
 * harness (Claude Code, Cursor agent, Codex, …), the CLI refuses by design;
 * the failure says so and how to run the check instead.
 *
 * node-pty is the terminal. On Linux, when it does not load or spawn, the
 * CLI runs under util-linux `script`, which allocates the pseudo-terminal
 * itself. BSD `script` (macOS) cannot be the fallback: it rejects the socket
 * Node gives a child as stdin. node-pty 1.1.0's macOS prebuild ships
 * `spawn-helper` without the executable bit (`posix_spawnp failed`); the
 * error then names the one-time fix.
 */
import { agentExecutionContextEnvNames } from '@agent/core/agent-execution-context';
import { assertGovernedExec, buildSafeExecEnv, safeSpawn } from '@agent/core/secure-io';

/** The prompt line `confirmDecisionByTtyChallenge` prints. */
const CHALLENGE_PROMPT = /Type ([0-9a-f]{6}) to (?:approve|reject)\b/u;
const OUTPUT_TAIL_CHARS = 2_000;

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

export function stripTerminalControl(output: string): string {
  return output.replace(ANSI_SEQUENCE, '').replace(/\r/gu, '');
}

/** The code the challenge asks for, or null while it has not been printed. */
export function extractTtyChallengeCode(output: string): string | null {
  return CHALLENGE_PROMPT.exec(stripTerminalControl(output))?.[1] ?? null;
}

/** What to do when the CLI refused because it runs inside an agent session. */
export function ttyChallengeFailureHint(output: string): string | null {
  const plain = stripTerminalControl(output);
  if (!/APPROVAL_HUMAN_PROOF_REQUIRED/u.test(plain)) return null;
  if (/runs under a provider CLI|agent session/u.test(plain)) {
    return (
      'the approval CLI refused because this check runs inside an agent session (a provider CLI among its parent processes) — ' +
      'this is the HA-04 attestation working, not a bypassable failure. Run the check from your own terminal ' +
      '(`pnpm kyberion check plugin-views-e2e`), not from an agent harness; CI runs it without one.'
    );
  }
  return null;
}

/** The child environment: the hermetic variables plus the safe allowlist, never an agent marker. */
export function ttyChallengeChildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildSafeExecEnv(extra))) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const name of agentExecutionContextEnvNames()) delete env[name];
  return env;
}

interface TerminalChild {
  via: 'node-pty' | 'script';
  write(text: string): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number | null) => void): void;
}

async function spawnWithNodePty(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<TerminalChild | { unavailable: string }> {
  try {
    const pty = await import('node-pty');
    const term = pty.spawn(command, args, { name: 'xterm', cols: 240, rows: 50, cwd, env });
    return {
      via: 'node-pty',
      write: (text) => term.write(text),
      kill: () => term.kill(),
      onData: (listener) => void term.onData(listener),
      onExit: (listener) => void term.onExit((event) => listener(event.exitCode)),
    };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** Why no pseudo-terminal can be started here, or null when one can. */
export function ttyChallengeTerminalUnavailable(nodePtyFailure: string): string | null {
  if (process.platform === 'linux') return null;
  const fix = /posix_spawnp failed/u.test(nodePtyFailure)
    ? ' — node-pty 1.1.0 ships its macOS spawn-helper without the executable bit; fix once with `chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`'
    : '';
  return `node-pty cannot start a pseudo-terminal (${nodePtyFailure})${fix}`;
}

/** Whether this host can run the challenge in a pseudo-terminal (null) or why not. */
export async function probeTtyChallengeTerminal(): Promise<string | null> {
  const probe = await spawnWithNodePty(
    process.execPath,
    ['-e', ''],
    process.cwd(),
    ttyChallengeChildEnv({})
  );
  if (!('unavailable' in probe)) {
    await new Promise<void>((resolve) => probe.onExit(() => resolve()));
    return null;
  }
  return ttyChallengeTerminalUnavailable(probe.unavailable);
}

function spawnWithScript(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): TerminalChild {
  const scriptArgs = [
    '-q',
    '-e',
    '-f',
    '-c',
    [command, ...args].map(quoteForShell).join(' '),
    '/dev/null',
  ];
  const child = safeSpawn('script', scriptArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    via: 'script',
    write: (text) => void child.stdin?.write(text),
    kill: () => void child.kill('SIGKILL'),
    onData: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    onExit: (listener) => void child.once('exit', (code) => listener(code)),
  };
}

export interface TtyChallengeRun {
  command: string;
  args: string[];
  cwd: string;
  /** Hermetic variables; the safe allowlist is added and agent markers are removed. */
  env: Record<string, string>;
  timeoutMs: number;
}

export interface TtyChallengeResult {
  output: string;
  via: TerminalChild['via'];
}

/** Runs the CLI in a pseudo-terminal, answers its challenge once, and requires exit 0. */
export async function runCliAnsweringTtyChallenge(
  run: TtyChallengeRun
): Promise<TtyChallengeResult> {
  assertGovernedExec(run.command, run.args);
  const env = ttyChallengeChildEnv(run.env);
  const viaPty = await spawnWithNodePty(run.command, run.args, run.cwd, env);
  if ('unavailable' in viaPty) {
    const unavailable = ttyChallengeTerminalUnavailable(viaPty.unavailable);
    if (unavailable)
      throw new Error(`${run.command} ${run.args.join(' ')} not run: ${unavailable}`);
  }
  const child =
    'unavailable' in viaPty ? spawnWithScript(run.command, run.args, run.cwd, env) : viaPty;
  const fallbackNote =
    'unavailable' in viaPty ? ` (node-pty unavailable: ${viaPty.unavailable})` : '';
  let output = '';
  let answered = false;
  return new Promise<TtyChallengeResult>((resolve, reject) => {
    const fail = (what: string) => {
      const plain = stripTerminalControl(output).slice(-OUTPUT_TAIL_CHARS);
      const hint = ttyChallengeFailureHint(output);
      reject(
        new Error(
          [
            `${run.command} ${run.args.join(' ')} ${what} via ${child.via}${fallbackNote}`,
            ...(hint ? [hint] : []),
            '--- terminal output (tail) ---',
            plain,
          ].join('\n')
        )
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(
        answered
          ? `did not finish within ${run.timeoutMs}ms`
          : `printed no challenge within ${run.timeoutMs}ms`
      );
    }, run.timeoutMs);
    child.onData((chunk) => {
      output += chunk;
      if (answered) return;
      const code = extractTtyChallengeCode(output);
      if (!code) return;
      answered = true;
      child.write(`${code}\r`);
    });
    child.onExit((exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0 && answered) resolve({ output, via: child.via });
      else fail(`exited ${String(exitCode)}${answered ? '' : ' before printing a challenge'}`);
    });
  });
}
