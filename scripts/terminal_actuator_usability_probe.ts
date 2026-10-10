import {
  handleAction,
  type TerminalAction,
  type TerminalResult,
} from '../libs/actuators/terminal-actuator/src/terminal-actuator-helpers.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { sleep } from '@agent/core/async-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Pattern = { pattern: string; passed: boolean; evidence?: unknown; error?: string };
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Real terminal interactions through one resident actuator; no direct PTY access. */
export async function runTerminalUsabilityProbe() {
  const root = pathResolver.sharedTmp(`terminal-usability/probe-${process.pid}`);
  safeMkdir(root, { recursive: true });
  const patterns: Pattern[] = [];
  let sessionId: string | undefined;
  const run = (action: TerminalAction['action'], params: TerminalAction['params'] = {}) =>
    handleAction({ action, params });
  async function check(pattern: string, task: () => Promise<unknown>) {
    try {
      patterns.push({ pattern, passed: true, evidence: await task() });
    } catch (error) {
      patterns.push({
        pattern,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async function until(predicate: (value: TerminalResult) => boolean, offset = 0) {
    const deadline = Date.now() + 5000;
    let result: TerminalResult;
    do {
      result = await run('poll', { sessionId, offset, limit: 16000 });
      if (predicate(result)) return result;
      await sleep(50);
    } while (Date.now() < deadline);
    throw new Error(`Terminal observation timed out: ${JSON.stringify(result)}`);
  }
  try {
    await check('spawn-non-login-shell', async () => {
      const result = await run('spawn', { shell: '/bin/sh', args: [], cwd: root });
      requireCondition(result.sessionId, 'Spawn returned no sessionId');
      sessionId = result.sessionId;
      return result;
    });
    if (sessionId) {
      await check('unicode-write-poll-offset', async () => {
        const text = '日本語 😀';
        requireCondition(
          (await run('write', { sessionId, data: `printf '%s\\n' '${text}'\n` })).success,
          'Write failed'
        );
        const first = await until((value) => String(value.output).includes(text));
        const offset = first.nextOffset;
        requireCondition(typeof offset === 'number' && offset > 0, 'Missing nextOffset');
        const second = await run('poll', { sessionId, offset, limit: 16000 });
        requireCondition(
          !String(second.output).includes(text),
          'Offset poll repeated consumed output'
        );
        return { first, second };
      });
      await check('bounded-output-slices', async () => {
        const first = await run('poll', { sessionId, offset: 0, limit: 2 });
        const remaining = await run('poll', { sessionId, offset: first.nextOffset, limit: 16000 });
        requireCondition(
          first.output?.length === 2 && `${first.output}${remaining.output}`.includes('日本語 😀'),
          'Bounded polling lost output or cursor'
        );
        return { first, remaining };
      });
      await check('list-running-session', async () => {
        const result = await run('list');
        requireCondition(result.sessions?.includes(sessionId), 'Running session absent from list');
        return result;
      });
      await check('resize-running-session', async () => {
        const result = await run('resize', { sessionId, cols: 100, rows: 30 });
        requireCondition(
          result.success ||
            (result.status === 'failed' && String(result.error).includes('cannot resize')),
          'Resize neither succeeded nor explained unavailable PTY dimensions'
        );
        return result;
      });
      await check('normal-exit-code', async () => {
        await run('write', { sessionId, data: 'exit 7\n' });
        const result = await until((value) => value.status === 'exited');
        requireCondition(result.exitCode === 7, 'Normal exit lost exitCode');
        return result;
      });
      await check('remove-exited-session', async () => {
        const result = await run('kill', { sessionId });
        requireCondition(result.success, 'Cleanup kill failed');
        requireCondition(
          !(await run('list')).sessions?.includes(sessionId),
          'Killed session remains listed'
        );
        sessionId = undefined;
        return result;
      });
    }
    await check('kill-running-session', async () => {
      const spawned = await run('spawn', { shell: '/bin/sh', args: [], cwd: root });
      sessionId = spawned.sessionId;
      requireCondition(sessionId, 'Spawn returned no sessionId');
      const killed = await run('kill', { sessionId });
      requireCondition(
        killed.success && !(await run('list')).sessions?.includes(sessionId),
        'Running terminal survived kill'
      );
      sessionId = undefined;
      return killed;
    });
    for (const action of ['poll', 'write', 'resize', 'kill'] as const) {
      await check(`unknown-session-${action}`, async () => {
        try {
          const result = await run(action, {
            sessionId: 'missing-usability-session',
            data: 'x',
            cols: 100,
            rows: 30,
            offset: 0,
          });
          requireCondition(
            result.status === 'failed' || result.ok === false,
            `Unknown session misleadingly returned ${JSON.stringify(result)}`
          );
          return result;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Unknown session misleadingly'))
            throw error;
          return { rejected: true, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  } finally {
    if (sessionId) await run('kill', { sessionId });
  }
  const result = {
    ok: patterns.every((item) => item.passed),
    patterns,
    report_path: `${root}/report.json`,
  };
  safeWriteFile(result.report_path, JSON.stringify(result, null, 2), { mkdir: true });
  return result;
}

const script = defineScript({
  name: 'terminal-actuator-usability-probe',
  run: async ({ print }) => {
    const result = await runTerminalUsabilityProbe();
    print(result);
    if (!result.ok)
      throw new ScriptExitError(1, 'Terminal usability patterns failed; inspect report_path');
    return result;
  },
});
if (
  isDirectScript(import.meta.url, 'terminal_actuator_usability_probe.ts') ||
  isDirectScript(import.meta.url, 'terminal_actuator_usability_probe.js')
)
  void script();
