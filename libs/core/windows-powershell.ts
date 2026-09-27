import { getRegisteredEnvText } from './foundation/env.js';

/**
 * Shared Windows PowerShell transport: every Kyberion PowerShell script runs
 * behind one fixed command-line bootstrap and travels on stdin, and request
 * values travel in a child environment variable (JSON), never in the script
 * text. Used by the os_accessibility detector (UI Automation walk) and the
 * Windows pointer path (DPI-aware clicks).
 */

// powershell.exe fails to start without SystemRoot (error 8009001d), and the
// secure-io child environment allowlist does not carry Windows system variables.
const WINDOWS_SYSTEM_ENV = ['SystemRoot', 'windir', 'PSModulePath'] as const;

/** powershell.exe -EncodedCommand payload (base64 of the UTF-16LE script). */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Fixed bootstrap passed on the command line: it reads the real script from
 * stdin and runs it as one script block. The scripts themselves (the
 * enumeration script with its C# walker is ~18 KB, far past the 32 767-char
 * Windows command-line limit once encoded) always travel on stdin, so the
 * command line has the same small size whatever the script. Scripts must be
 * ASCII: stdin is decoded with the console code page.
 */
export const POWERSHELL_STDIN_BOOTSTRAP =
  "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create([Console]::In.ReadToEnd()))";

/** powershell.exe arguments that run the script given on stdin (see POWERSHELL_STDIN_BOOTSTRAP). */
export function powerShellStdinArgs(): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShellCommand(POWERSHELL_STDIN_BOOTSTRAP),
  ];
}

/**
 * Windows system variables powershell.exe needs to start, which the secure-io
 * child environment allowlist does not carry.
 */
export function windowsPowerShellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WINDOWS_SYSTEM_ENV) {
    const value = getRegisteredEnvText(name);
    if (value) env[name] = value;
  }
  return env;
}
