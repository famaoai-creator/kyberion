import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  buildSafeExecEnv,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript } from './lib/harness.js';
import { parseSafeJsonObjectInput } from './lib/json-input.js';

type Print = (value: unknown) => void;

type ArgMap = Record<string, string | boolean>;

function printUsage(print: Print): void {
  print('Usage: pnpm google-workspace-meet -- <create> [options]');
  print('  pnpm google-workspace-meet -- create --json \'{"summary":"Planning"}\'');
}

function parseArgs(argv: string[]): { command: string; args: ArgMap; help: boolean } {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const help = normalized[0] === '--help' || normalized[0] === '-h';
  const command = normalized[0] && !normalized[0].startsWith('--') ? normalized[0] : 'create';
  const rest = normalized[0] && !normalized[0].startsWith('--') ? normalized.slice(1) : normalized;
  const args: ArgMap = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) continue;
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      args[current] = true;
      continue;
    }
    args[current] = next;
    index += 1;
  }
  return { command, args, help };
}

function getString(args: ArgMap, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

export function readPayload(args: ArgMap): Record<string, unknown> {
  const payloadFile = getString(args, '--payload-file');
  if (payloadFile) {
    const resolvedPayloadFile = assertSafeRepositoryPath(
      path.isAbsolute(payloadFile) ? payloadFile : pathResolver.resolve(payloadFile),
      { allowMissingLeaf: false }
    );
    if (!safeExistsSync(resolvedPayloadFile)) {
      throw new Error(`payload file not found: ${resolvedPayloadFile}`);
    }
    if (!safeLstat(resolvedPayloadFile).isFile()) {
      throw new Error(`payload file must be a regular file: ${resolvedPayloadFile}`);
    }
    const raw = String(safeReadFile(resolvedPayloadFile, { encoding: 'utf8' }) || '').trim();
    if (!raw) {
      throw new Error(`payload file is empty: ${resolvedPayloadFile}`);
    }
    return parseSafeJsonObjectInput(raw, 'Google Workspace Meet payload') || {};
  }

  const rawJson = getString(args, '--json', '{}').trim();
  if (!rawJson) return {};
  return parseSafeJsonObjectInput(rawJson, 'Google Workspace Meet payload') || {};
}

async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const { command, args, help } = parseArgs(argv);

  if (help || command === 'help') {
    printUsage(print);
    return;
  }

  if (command !== 'create') {
    printUsage(print);
    throw new Error(`unknown command '${command}' (expected create)`);
  }

  const payload = readPayload(args);
  const env = buildSafeExecEnv({
    CLOUDSDK_PYTHON: getString(args, '--cloudsdk-python') || process.env.CLOUDSDK_PYTHON,
  });
  const output = safeExec('gws', ['meet', 'spaces', 'create', '--json', JSON.stringify(payload)], {
    env,
    timeoutMs: 120000,
  }).trim();
  print(output);
}

const script = defineScript({
  name: 'google-workspace:meet',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'google_workspace_meet.ts') ||
  isDirectScript(import.meta.url, 'google_workspace_meet.js')
) {
  void script();
}
