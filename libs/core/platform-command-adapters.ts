import { safeExecResult } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { getPlatformFacts, locateCommandInvocation, platformFacts } from './platform-facts.js';

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
  return getPlatformFacts(platform).family === 'windows' ? windowsShell : resolvePosixShell();
}

export const commandLocatorAdapter: CommandLocatorAdapter = {
  locate(command: string): string[] {
    const [locator, ...locatorArgs] = locateCommandInvocation(command, platformFacts, {
      all: true,
    });
    const result = safeExecResult(locator, locatorArgs, { maxOutputMB: 1 });
    return result.status === 0
      ? result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  },
};
