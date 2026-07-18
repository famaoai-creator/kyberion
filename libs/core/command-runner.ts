import { safeExecResult } from './secure-io.js';

export interface GovernedCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputMB?: number;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
}

export interface GovernedCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export function runGovernedCommand(
  command: string,
  args: string[] = [],
  options: GovernedCommandOptions = {}
): GovernedCommandResult {
  return safeExecResult(command, args, options);
}

export function runGovernedJsonCommand<T>(
  command: string,
  args: string[] = [],
  options: GovernedCommandOptions = {}
): T {
  const result = runGovernedCommand(command, args, options);
  if (result.error || result.status !== 0) {
    throw (
      result.error || new Error(result.stderr || `${command} exited with status ${result.status}`)
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
