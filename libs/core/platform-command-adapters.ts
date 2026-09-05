import { safeExecResult } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';

export interface ShellAdapter {
  readonly shell: string;
  readonly args: string[];
}

export interface CommandLocatorAdapter {
  locate(command: string): string[];
}

const windowsShell: ShellAdapter = { shell: 'powershell.exe', args: ['-Command'] };
function resolvePosixShell(): ShellAdapter {
  return { shell: getRegisteredEnvText('SHELL') || '/bin/bash', args: ['-lc'] };
}

export function resolveShellAdapter(platform: NodeJS.Platform = process.platform): ShellAdapter {
  return platform === 'win32' ? windowsShell : resolvePosixShell();
}

export const commandLocatorAdapter: CommandLocatorAdapter = {
  locate(command: string): string[] {
    const result =
      process.platform === 'win32'
        ? safeExecResult('where', [command], { maxOutputMB: 1 })
        : safeExecResult('which', ['-a', command], { maxOutputMB: 1 });
    return result.status === 0
      ? result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  },
};
