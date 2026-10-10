import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  extractTtyChallengeCode,
  probeTtyChallengeTerminal,
  runCliAnsweringTtyChallenge,
  ttyChallengeChildEnv,
  ttyChallengeFailureHint,
  ttyChallengeTerminalUnavailable,
} from './cli-tty-challenge-driver.js';

/** A stand-in for the approval CLI: refuses without a TTY, prints a code, checks the answer. */
const FAKE_CHALLENGE_CLI = [
  "if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('[APPROVAL_HUMAN_PROOF_REQUIRED] not interactive\\n'); process.exit(3); }",
  "process.stdout.write('\\u001b[1mApprove req-1\\u001b[0m\\r\\nType 0a1b2c to approve (anything else cancels): ');",
  "process.stdin.setEncoding('utf8');",
  "let typed = '';",
  "process.stdin.on('data', (chunk) => { typed += chunk; if (/[\\r\\n]/.test(typed)) { process.stdout.write(typed.trim() === '0a1b2c' ? '\\napproved\\n' : '\\nmismatch\\n'); process.exit(typed.trim() === '0a1b2c' ? 0 : 4); } });",
].join('\n');

/** Linux CI always has a terminal (node-pty, else util-linux `script`); see the driver module. */
const terminalUnavailable = await probeTtyChallengeTerminal();

describe('cli tty challenge driver', () => {
  it('reads the challenge code through terminal control sequences', () => {
    expect(
      extractTtyChallengeCode('\u001b[2K\r\nType 9f8e7d to approve (anything else cancels): ')
    ).toBe('9f8e7d');
    expect(extractTtyChallengeCode('Type 9f8e7d to reject (anything')).toBe('9f8e7d');
    expect(extractTtyChallengeCode('Approve req-1: deploy')).toBeNull();
  });

  it('explains an agent-session refusal instead of hiding it', () => {
    expect(
      ttyChallengeFailureHint(
        '[APPROVAL_HUMAN_PROOF_REQUIRED] approval decision blocked — this command runs under a provider CLI (claude-cli)'
      )
    ).toMatch(/Run the check from your own terminal/u);
    expect(ttyChallengeFailureHint('[POLICY_VIOLATION] challenge timed out')).toBeNull();
  });

  it('never passes an agent-session marker to the CLI', () => {
    const env = ttyChallengeChildEnv({
      KYBERION_ROOT: '/tmp/root',
      CLAUDECODE: '1',
      KYBERION_AGENT_ID: 'agent:planner',
      AI_AGENT: 'cursor',
    });
    expect(env.KYBERION_ROOT).toBe('/tmp/root');
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('KYBERION_AGENT_ID');
    expect(env).not.toHaveProperty('AI_AGENT');
  });

  it('names the one-time fix when node-pty cannot spawn on macOS', () => {
    expect(ttyChallengeTerminalUnavailable('posix_spawnp failed.')).toEqual(
      process.platform === 'linux' ? null : expect.stringContaining('chmod +x')
    );
  });

  it.skipIf(terminalUnavailable !== null)(
    'answers the challenge in a pseudo-terminal',
    async () => {
      const result = await runCliAnsweringTtyChallenge({
        command: process.execPath,
        args: ['-e', FAKE_CHALLENGE_CLI],
        cwd: pathResolver.rootDir(),
        env: {},
        timeoutMs: 20_000,
      });
      expect(result.output).toContain('approved');
    },
    30_000
  );

  it.skipIf(terminalUnavailable !== null)(
    'fails with the tail of the output when no challenge is printed',
    async () => {
      await expect(
        runCliAnsweringTtyChallenge({
          command: process.execPath,
          args: ['-e', "process.stdout.write('nothing to see\\n'); process.exit(2);"],
          cwd: pathResolver.rootDir(),
          env: {},
          timeoutMs: 20_000,
        })
      ).rejects.toThrow(/exited 2 before printing a challenge[\s\S]*nothing to see/u);
    },
    30_000
  );
});
