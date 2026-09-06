#!/usr/bin/env node
/**
 * CLI entry that prefers the compiled kyberion binary, but can still list
 * actuator capabilities from source when dist/ is missing.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_CLI = resolve(ROOT, 'dist/scripts/kyberion.js');
const args = process.argv.slice(2);
const command = args[0];

function run(nodeArgs) {
  const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

const discoveryCommands = new Set(['list', 'help', '--help', '-h']);

if (existsSync(DIST_CLI)) {
  run([DIST_CLI, ...args]);
} else if (!command || discoveryCommands.has(command)) {
  const forwarded =
    command === 'list' ? args.slice(1) : args.filter((arg) => !discoveryCommands.has(arg));
  run(['scripts/capability_discovery_entry.mjs', ...forwarded]);
} else {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodeHint =
    nodeMajor < 24
      ? `This process is Node ${process.versions.node}; package.json engines require Node >=24. Use nvm install 24 && nvm use 24, then rebuild.`
      : `Node ${process.versions.node} meets engines (>=24).`;
  console.error(
    [
      `Kyberion CLI execution needs a build (missing ${DIST_CLI}).`,
      nodeHint,
      'Cloud Agent / fresh VM: see docs/developer/CLOUD_AGENT_ENVIRONMENT.md',
      'Discovery without build: pnpm capabilities',
      '  or: pnpm kyberion list',
      'Execution: pnpm build && pnpm kyberion <command>',
      "Doctor: pnpm run doctor  or  pnpm kyberion:doctor  (not bare `pnpm doctor`, which is pnpm's own doctor)",
    ].join('\n')
  );
  process.exit(1);
}
