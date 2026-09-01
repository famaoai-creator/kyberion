import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';

export interface HudExecResult {
  ok: boolean;
  output: string;
}

export type HudExecFn = (
  command: string,
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number }
) => HudExecResult;

function defaultExec(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {}
): HudExecResult {
  const result = safeExecResult(command, args, {
    cwd: pathResolver.rootDir(),
    timeoutMs: options.timeoutMs ?? 120000,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const output = [result.stdout, result.stderr]
    .map((chunk) => chunk?.trim())
    .filter(Boolean)
    .join('\n');
  return {
    ok: result.status === 0,
    output: result.error ? `${output}\n${result.error.message}` : output,
  };
}

let execImpl: HudExecFn = defaultExec;

export function hudExec(
  command: string,
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number }
): HudExecResult {
  return execImpl(command, args, options);
}

export function setHudExecForTesting(fn: HudExecFn): void {
  execImpl = fn;
}

export function resetHudExec(): void {
  execImpl = defaultExec;
}

export function distScript(name: string): string {
  return path.join(pathResolver.rootDir(), 'dist', 'scripts', name);
}
