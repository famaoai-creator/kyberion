/**
 * Small cross-platform command runner for package scripts.
 *
 * npm executes scripts through the host shell.  `NAME=value command` therefore
 * works on POSIX but is parsed as a command on Windows.  Keeping the process
 * launch in the governed secure-io wrapper gives both shells identical
 * behaviour without requiring a shell or a third-party dependency.
 */
import { safeExec } from '@agent/core/secure-io';

const assignments: Record<string, string> = {};
let index = 2;
for (; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  if (!match) break;
  assignments[match[1]] = match[2];
}

const command = process.argv[index];
if (!command) throw new Error('Usage: run_with_env.ts [NAME=value ...] command [args ...]');
safeExec(command, process.argv.slice(index + 1), { env: assignments });
