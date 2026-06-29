import { createStandardYargs } from '@agent/core/cli-utils';
import { buildSafeExecEnv, safeExec, safeExistsSync, safeReadFile } from '@agent/core';

type ArgMap = Record<string, string | boolean>;

function printUsage(): void {
  console.log('Usage: pnpm google-workspace-meet -- <create> [options]');
  console.log('  pnpm google-workspace-meet -- create --json \'{"summary":"Planning"}\'');
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

function readPayload(args: ArgMap): Record<string, unknown> {
  const payloadFile = getString(args, '--payload-file');
  if (payloadFile) {
    if (!safeExistsSync(payloadFile)) {
      throw new Error(`payload file not found: ${payloadFile}`);
    }
    const raw = String(safeReadFile(payloadFile, { encoding: 'utf8' }) || '').trim();
    if (!raw) {
      throw new Error(`payload file is empty: ${payloadFile}`);
    }
    return JSON.parse(raw);
  }

  const rawJson = getString(args, '--json', '{}').trim();
  if (!rawJson) return {};
  return JSON.parse(rawJson);
}

async function main(): Promise<void> {
  const { command, args, help } = parseArgs(process.argv.slice(2));

  if (help || command === 'help') {
    printUsage();
    return;
  }

  if (command !== 'create') {
    printUsage();
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
  console.log(output);
}

const isDirect = process.argv[1] && /google_workspace_meet\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
