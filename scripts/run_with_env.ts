/**
 * Small cross-platform command runner for package scripts.
 *
 * npm executes scripts through the host shell.  `NAME=value command` therefore
 * works on POSIX but is parsed as a command on Windows.  Keeping the process
 * launch in the governed secure-io wrapper gives both shells identical
 * behaviour without requiring a shell or a third-party dependency.
 */
import { safeExec } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export function main(argv: string[] = []): void {
  const assignments: Record<string, string> = {};
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!match) break;
    assignments[match[1]] = match[2];
  }

  const command = argv[index];
  if (!command) throw new Error('Usage: run_with_env.ts [NAME=value ...] command [args ...]');
  // LC-14: this wrapper is used by `surfaces:*` package scripts. Forward the
  // child stdout so status/reconcile results remain visible to the operator.
  const output = safeExec(command, argv.slice(index + 1), { env: assignments });
  if (output) process.stdout.write(output);
}

if (
  isDirectScript(import.meta.url, 'run_with_env.ts') ||
  isDirectScript(import.meta.url, 'run_with_env.js')
)
  void defineScript({ name: 'run-with-env', flags: [], run: ({ argv }) => main(argv) })();
