/**
 * `pnpm kyberion system` — interactive surface for the system-actuator.
 *
 *   ops [--kind capture|transform|apply|control]
 *                       List the system op vocabulary (from the governed
 *                       actuator-op-registry) grouped by step kind
 *   <op> [--params <json>] [--<key> <value>] [--dry-run]
 *                       Run one `system:<op>` step through the actuator —
 *                       same op catalog, schemas and preflight gates as a
 *                       pipeline step, without authoring a pipeline
 *   interact <type> [--params <json>] [--session <id>] [--target <json>]
 *                       Run one `computer_interaction` action (ax_*, type,
 *                       key, clicks, …). Destructive actions stay behind the
 *                       actuator's op-preflight / approval boundary — this
 *                       surface only admits what the governed path admits.
 *
 * `exec`/`shell` and other raw-command ops are intentionally not exposed
 * here: pipeline steps can still reach them through the governed ADF path.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExec, safeMkdir } from '@agent/core/secure-io';
import { writeJson } from '@agent/core/foundation/json';
import { loadOpDomain } from '../lib/actuator-op-registry.js';
import { ScriptExitError } from '../lib/harness.js';

const ACTUATOR_ENTRY_REL = 'libs/actuators/system-actuator/src/index.ts';

/** Raw-command ops stay off the interactive surface (see module header). */
const BLOCKED_OPS = new Set(['exec', 'shell', 'run_js']);

const SYSTEM_USAGE = `Usage: pnpm kyberion system <command> [options]

  ops [--kind capture|transform|apply|control]
  <op> [--params <json>] [--<key> <value>] [--dry-run]
  interact <type> [--params <json>] [--session <id>] [--target <json>]

  <op> is a registry op name (see \`system ops\`): screenshot, ask_screen,
  window_list, probe, glob_files, …`;

function fail(message: string): never {
  throw new ScriptExitError(1, `${message}\n\n${SYSTEM_USAGE}`);
}

function loadSystemOps(): Record<string, 'capture' | 'transform' | 'apply' | 'control'> {
  const domain = loadOpDomain('system');
  if (!domain) throw new ScriptExitError(1, 'actuator-op-registry has no system domain');
  return domain.kinds;
}

interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (['json', 'dry-run', 'verbose'].includes(name)) {
      options[name] = true;
    } else {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
      options[name] = value;
      i += 1;
    }
  }
  return { positionals, options };
}

const RESERVED_OPTIONS = new Set([
  'json',
  'dry-run',
  'verbose',
  'params',
  'session',
  'target',
  'kind',
  'help',
]);

function buildParams(parsed: ParsedArgs): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const raw = parsed.options.params;
  if (raw !== undefined && raw !== true) {
    try {
      const decoded = JSON.parse(String(raw)) as unknown;
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        fail('--params must be a JSON object');
      }
      Object.assign(params, decoded);
    } catch (err) {
      if (err instanceof ScriptExitError) throw err;
      fail(`--params is not valid JSON: ${String(err)}`);
    }
  }
  for (const [key, value] of Object.entries(parsed.options)) {
    if (RESERVED_OPTIONS.has(key) || value === true) continue;
    try {
      params[key] = JSON.parse(value as string) as unknown;
    } catch {
      params[key] = value;
    }
  }
  return params;
}

function runActuator(input: Record<string, unknown>, tag: string, dryRun: boolean): string {
  const dir = pathResolver.sharedTmp('cli-system');
  safeMkdir(dir);
  const inputPath = assertSafeRepositoryPath(path.join(dir, `${Date.now()}-${tag}.json`), {
    rootDir: pathResolver.rootDir(),
    allowMissingLeaf: true,
  });
  writeJson(inputPath, input);
  const args = [
    '--import',
    pathToFileURL(pathResolver.rootResolve('scripts/ts-loader.mjs')).href,
    pathResolver.rootResolve(ACTUATOR_ENTRY_REL),
    '--input',
    inputPath,
    ...(dryRun ? ['--dry-run'] : []),
  ];
  return safeExec('node', args, { cwd: pathResolver.rootDir(), timeoutMs: 300_000 });
}

export async function runSystemCommand(
  args: string[],
  print: (line: string) => void
): Promise<void> {
  const parsed = parseArgs(args);
  const [verb] = parsed.positionals;
  if (!verb || parsed.options.help === true) fail('missing command');
  const ops = loadSystemOps();

  if (verb === 'ops') {
    const kindFilter = parsed.options.kind;
    const grouped: Record<string, string[]> = {};
    for (const [op, kind] of Object.entries(ops)) {
      if (kindFilter !== undefined && kindFilter !== true && kind !== kindFilter) continue;
      (grouped[kind] ??= []).push(op);
    }
    print(JSON.stringify(grouped, null, 2));
    return;
  }

  if (verb === 'interact') {
    const type = parsed.positionals[1];
    if (!type) fail('interact needs <type> (ax_snapshot, type, key, left_click, …)');
    const params = buildParams(parsed);
    const input: Record<string, unknown> = {
      version: '0.1',
      kind: 'computer_interaction',
      action: { type, ...params },
    };
    const sessionId = parsed.options.session;
    if (typeof sessionId === 'string') input.session_id = sessionId;
    const target = parsed.options.target;
    if (typeof target === 'string') {
      try {
        input.target = JSON.parse(target) as unknown;
      } catch {
        fail('--target is not valid JSON');
      }
    }
    const out = runActuator(input, `interact-${type}`, parsed.options['dry-run'] === true);
    if (out.trim()) print(out.trim());
    return;
  }

  const op = verb.replace(/^system:/, '');
  const kind = ops[op];
  if (!kind || BLOCKED_OPS.has(op)) {
    fail(
      `op '${verb}' is not exposed on this surface ` +
        `(see \`pnpm kyberion system ops\` for the vocabulary; pipelines reach the rest via ADF)`
    );
  }
  const params = buildParams(parsed);
  const input = {
    action: 'pipeline',
    steps: [{ type: kind, op, params }],
  };
  const out = runActuator(input, op, parsed.options['dry-run'] === true);
  if (out.trim()) print(out.trim());
}
