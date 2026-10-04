import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  loadActuatorManifest,
  type ActuatorManifestFile,
} from '@agent/core/actuator-manifest-index';
import {
  actuatorManifestAcceptsPipeline,
  buildSingleOpPipelinePayload,
  planActuatorDryRun,
  resolveCliActionKind,
} from '@agent/core/actuator/actuator-sdk';
import { createAjv } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as readline from 'node:readline';
import chalk from 'chalk';
import * as path from 'node:path';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';
import { parseSafeJsonInput, parseSafeJsonObjectInput } from './lib/json-input.js';

type Print = (value: unknown) => void;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function parseCliArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      parsed[key] = value;
    }
  }
  return parsed;
}

function tryCoerceValue(val: string): any {
  if (val.toLowerCase() === 'true') return true;
  if (val.toLowerCase() === 'false') return false;
  if (!isNaN(Number(val)) && val !== '') return Number(val);
  if (val.startsWith('{') || val.startsWith('[')) {
    try {
      return parseSafeJsonInput(val, 'actuator parameter');
    } catch (_) {
      // Fallback to string if parsing fails
    }
  }
  return val;
}

export function parsePlaygroundParams(raw: string, label = '--params'): Record<string, unknown> {
  return parseSafeJsonObjectInput(raw, label) || {};
}

export function buildPlaygroundPayload(
  operation: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  return {
    action: operation,
    op: operation,
    params,
  };
}

/**
 * Merge manifest capabilities with fine-grained describeOps from the
 * generated discovery index. Pipeline-style actuators (file/browser/media)
 * expose only `pipeline` in manifest.json while describeOps lists the real
 * single-op surface (e.g. file:read). Without this merge the playground
 * rejects valid ops with "Machine mode requires --op".
 */
export function loadDiscoveryOpsForActuator(actuatorId: string, dirId = ''): string[] {
  return loadDiscoveryOpDetailsForActuator(actuatorId, dirId).map((entry) => entry.op);
}

export function loadDiscoveryOpDetailsForActuator(
  actuatorId: string,
  dirId = ''
): Array<{ op: string; kind: string }> {
  try {
    const discoveryPath = pathResolver.rootResolve(
      'knowledge/product/orchestration/actuator-op-discovery.json'
    );
    if (!safeExistsSync(discoveryPath)) return [];
    const raw = String(safeReadFile(discoveryPath, { encoding: 'utf8' }));
    const parsed = JSON.parse(raw) as {
      actuators?: Array<{ n?: string; path?: string; ops?: Array<{ op?: string; kind?: string }> }>;
    };
    const entries = Array.isArray(parsed.actuators) ? parsed.actuators : [];
    const match = entries.find(
      (entry) =>
        entry?.n === actuatorId ||
        (dirId !== '' && (entry?.n === dirId || entry?.path?.endsWith(`/${dirId}`)))
    );
    if (!match || !Array.isArray(match.ops)) return [];
    return match.ops
      .map((op) => ({
        op: typeof op?.op === 'string' ? op.op.trim() : '',
        kind: typeof op?.kind === 'string' ? op.kind.trim() : 'capture',
      }))
      .filter((entry) => entry.op !== '');
  } catch {
    return [];
  }
}

export function lookupDiscoveryOpKind(actuatorId: string, op: string, dirId = ''): string | null {
  const details = loadDiscoveryOpDetailsForActuator(actuatorId, dirId);
  return details.find((entry) => entry.op === op)?.kind ?? null;
}

/**
 * Actuators whose CLI boundary accepts `{action:"pipeline", steps:[...]}`
 * (pure pipeline-driven like file/network/media, or mixed like browser/code).
 * A bare `{action:"read"}` fails there with "pure pipeline-driven" — wrap a
 * single describeOps selection into a one-step pipeline so playground try-out
 * matches the real ADF step shape. Actuators without a `pipeline` entry
 * (agent/secret/…) dispatch single actions directly and must NOT be wrapped.
 */
export function actuatorAcceptsPipeline(manifest: ActuatorManifestFile): boolean {
  return actuatorManifestAcceptsPipeline(manifest);
}
export function buildPipelineWrappedPayload(
  op: string,
  params: Record<string, unknown>,
  kind: string
): Record<string, unknown> {
  return buildSingleOpPipelinePayload(op, params, kind);
}

export function resolvePlaygroundCapabilities(
  manifest: ActuatorManifestFile,
  dirId = ''
): ActuatorManifestFile['capabilities'] {
  const base = Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [];
  const seen = new Set(base.map((capability) => capability.op));
  for (const op of loadDiscoveryOpsForActuator(manifest.actuator_id, dirId)) {
    if (seen.has(op)) continue;
    seen.add(op);
    base.push({ op, platforms: [] });
  }
  return base;
}

/**
 * Live secret:set with a value must go through `kyberion secret introduce` /
 * Concierge — playground may only dry-run / check that path.
 */
export function assertPlaygroundSecretMutationAllowed(args: {
  actuatorId: string;
  operation: string;
  params: Record<string, unknown>;
  dryRun?: boolean;
  check?: boolean;
}): void {
  const actuatorId = String(args.actuatorId || '').toLowerCase();
  const operation = String(args.operation || '').toLowerCase();
  if (actuatorId !== 'secret-actuator' || operation !== 'set') return;
  if (args.dryRun === true || args.check === true) return;
  if (typeof args.params?.value === 'string' && args.params.value.length > 0) {
    throw new Error(
      '[PLAYGROUND_SECRET_SET_BLOCKED] Live secret:set with a value is not allowed in playground. ' +
        'Use `pnpm kyberion secret introduce <serviceId> <secretKey>` or Concierge Introduce secret. ' +
        'Dry-run/check without applying a value remains available.'
    );
  }
}

export function evaluatePlaygroundDryRun(args: {
  actuatorId: string;
  operation: string;
  payload: Record<string, unknown>;
  contractSchemaPath?: string;
  mode?: 'dry-run' | 'check';
}): Record<string, unknown> {
  const kind = resolveCliActionKind(args.payload);
  const plan = planActuatorDryRun({ kind, dryRun: true });
  let validated = true;
  let error: string | undefined;
  if (args.contractSchemaPath) {
    try {
      const ajv = createAjv();
      const schemaPath = pathResolver.rootResolve(args.contractSchemaPath);
      const validate = compileSchemaFromPath(ajv, schemaPath);
      if (!validate(args.payload)) {
        validated = false;
        error = (validate.errors || [])
          .map((item) => `${item.instancePath || '/'} ${item.message || 'is invalid'}`)
          .join('; ');
      }
    } catch (err) {
      validated = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    ok: validated,
    mode: args.mode ?? 'dry-run',
    actuator_id: args.actuatorId,
    operation: args.operation,
    kind,
    dry_run: true,
    handler: plan.skipHandler ? 'skipped' : 'capture',
    validated,
    ...(error ? { error } : {}),
    payload: args.payload,
  };
}

export type PlaygroundExecuteActuator = (args: {
  execPath: string;
  inputPath: string;
  extraArgs: string[];
}) => string;

interface PlaygroundRunOptions {
  dryRun?: boolean;
  check?: boolean;
  json?: boolean;
  quiet?: boolean;
  print?: Print;
  /** Test seam: skip dist lookup. */
  resolveExecutable?: (actuatorId: string) => string | null;
  /** Test seam: intercept the compiled actuator process. */
  executeActuator?: PlaygroundExecuteActuator;
}

function defaultExecuteActuator(args: {
  execPath: string;
  inputPath: string;
  extraArgs: string[];
}): string {
  return safeExec('node', [args.execPath, '--input', args.inputPath, ...args.extraArgs], {
    cwd: pathResolver.rootDir(),
  });
}

export async function runPlayground(
  args: string[],
  options: PlaygroundRunOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const machineOutput = options.json === true || options.dryRun === true || options.check === true;
  const print = options.print ?? (() => undefined);
  const emit = (...values: unknown[]): void => values.forEach((value) => print(value));
  const log = (...values: unknown[]) => {
    if (!machineOutput && !options.quiet) emit(...values);
  };
  const logError = (...values: unknown[]) => {
    if (!machineOutput && !options.quiet) emit(...values);
  };

  log(chalk.bold.cyan('\n🛠️  [KYBERION] Actuator Playground CLI\n'));

  // 1. Scan available actuators
  const actuatorsDir = assertSafeRepositoryPath(pathResolver.rootResolve('libs/actuators'));
  const dirEntries = safeReaddir(actuatorsDir);
  const actuators: { id: string; manifestPath: string; manifest: ActuatorManifestFile }[] = [];

  for (const entry of dirEntries) {
    let manifestPath: string;
    try {
      manifestPath = assertSafeRepositoryPath(path.join(actuatorsDir, entry, 'manifest.json'), {
        allowMissingLeaf: false,
      });
    } catch {
      continue;
    }
    if (safeExistsSync(manifestPath) && safeLstat(manifestPath).isFile()) {
      try {
        const manifest = loadActuatorManifest(manifestPath);
        if (manifest && manifest.actuator_id) {
          actuators.push({
            id: entry,
            manifestPath,
            manifest,
          });
        }
      } catch (err: any) {
        // Skip invalid manifests
      }
    }
  }

  if (actuators.length === 0) {
    logError(chalk.red('❌ No valid actuators with manifest.json found in libs/actuators/'));
    rl.close();
    throw new ScriptExitError(1, 'No valid actuators with manifest.json found');
  }

  // 2. Parse CLI args for non-interactive mode
  const cliParams = parseCliArgs(args);
  let targetActuatorId = cliParams.actuator;
  let targetOp = cliParams.op;
  let rawParamsStr = cliParams.params;

  let selectedActuator = actuators.find(
    (a) => a.id === targetActuatorId || a.manifest.actuator_id === targetActuatorId
  );

  // 3. Actuator Selection Wizard
  if (!selectedActuator) {
    if (machineOutput) {
      rl.close();
      throw new ScriptExitError(
        1,
        'Machine mode requires --actuator, --op, and --params; omit them only for interactive mode.'
      );
    }
    log(chalk.white('Available Actuators:'));
    actuators.forEach((act, idx) => {
      log(
        `  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(act.manifest.actuator_id)} (v${act.manifest.version})`
      );
      log(`     ${chalk.gray(act.manifest.description)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Actuator by number: '));
    const idx = parseInt(choiceStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actuators.length) {
      logError(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      throw new ScriptExitError(1, 'Invalid actuator selection');
    }
    selectedActuator = actuators[idx];
  }

  const manifest = selectedActuator.manifest;
  log(chalk.green(`\n✓ Selected Actuator: ${chalk.bold(manifest.actuator_id)}`));

  // 4. Operation Selection Wizard
  // Manifest is coarse (pipeline-style actuators list only `pipeline`);
  // union with describeOps from the discovery index so single ops work.
  const ops = resolvePlaygroundCapabilities(manifest, selectedActuator.id);
  let selectedOpObj = ops.find((o) => o.op === targetOp);

  if (!selectedOpObj) {
    if (ops.length === 0) {
      logError(chalk.red(`\n❌ Actuator '${manifest.actuator_id}' defines no capabilities.`));
      rl.close();
      throw new ScriptExitError(1, `Actuator '${manifest.actuator_id}' defines no capabilities`);
    }
    if (machineOutput) {
      rl.close();
      if (!targetOp) {
        throw new ScriptExitError(1, 'Machine mode requires --op for the selected actuator.');
      }
      throw new ScriptExitError(
        1,
        `Unknown --op '${targetOp}' for '${manifest.actuator_id}'. ` +
          `Available: ${ops.map((o) => o.op).join(', ')}. ` +
          `Fine-grained ops come from knowledge/product/orchestration/actuator-op-discovery.json.`
      );
    }

    log(chalk.white('\nAvailable Operations (ops):'));
    ops.forEach((opObj, idx) => {
      const desc = opObj.description ? ` - ${opObj.description}` : '';
      log(`  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(opObj.op)}${chalk.gray(desc)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Operation by number: '));
    const idx = parseInt(choiceStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= ops.length) {
      logError(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      throw new ScriptExitError(1, 'Invalid operation selection');
    }
    selectedOpObj = ops[idx];
  }

  const op = selectedOpObj.op;
  log(chalk.green(`✓ Selected Operation: ${chalk.bold(op)}`));

  // 5. Parameter Gathering Wizard
  let paramsObject: Record<string, any> = {};

  if (rawParamsStr) {
    try {
      paramsObject = parsePlaygroundParams(rawParamsStr);
    } catch (err: any) {
      logError(chalk.red(`\n❌ Failed to parse --params JSON: ${err.message}`));
      rl.close();
      throw new ScriptExitError(1, `Failed to parse --params JSON: ${err.message}`);
    }
  } else {
    if (machineOutput) {
      rl.close();
      throw new ScriptExitError(1, 'Machine mode requires --params with a JSON object.');
    }
    log(chalk.white('\nHow would you like to provide the operation parameters?'));
    log(chalk.cyan('  1. Interactive Wizard (key-value prompting)'));
    log(chalk.cyan('  2. Paste Raw JSON block'));

    const methodChoice = await question(chalk.bold.blue('\nChoose method (1 or 2): '));

    if (methodChoice === '2') {
      log(
        chalk.yellow(
          '\nPaste the full JSON value for "params" (e.g. {"channel": "slack", "text": "hello"}):'
        )
      );
      const jsonStr = await question('> ');
      try {
        paramsObject = parsePlaygroundParams(jsonStr, 'params');
      } catch (err: any) {
        logError(chalk.red(`❌ Invalid JSON block: ${err.message}`));
        rl.close();
        throw new ScriptExitError(1, `Invalid JSON block: ${err.message}`);
      }
    } else {
      log(chalk.yellow('\nEnter parameter key-value pairs one by one. Leave key empty to finish.'));
      while (true) {
        const key = await question(chalk.bold.magenta('\nParameter Key: '));
        if (!key) break;
        const valStr = await question(chalk.bold.blue(`Value for '${key}': `));
        paramsObject[key] = tryCoerceValue(valStr);
      }
    }
  }

  // 6. Construct Payload
  // Include both 'op' and 'action' for seamless compatibility across different actuator conventions.
  // Discovery-only ops on actuators that accept `pipeline` are wrapped into
  // the same one-step pipeline ADF the runtime executes, so playground
  // try-out matches production. Actuators without a `pipeline` entry
  // (agent/secret/…) dispatch single actions directly and stay bare.
  const isManifestOp = (manifest.capabilities || []).some((entry) => entry.op === op);
  const discoveryKind = isManifestOp
    ? null
    : lookupDiscoveryOpKind(manifest.actuator_id, op, selectedActuator.id);
  const isPipelineWrapped = discoveryKind !== null && actuatorAcceptsPipeline(manifest);
  const payload = isPipelineWrapped
    ? buildPipelineWrappedPayload(op, paramsObject, discoveryKind as string)
    : buildPlaygroundPayload(op, paramsObject);
  if (isPipelineWrapped && !machineOutput) {
    log(
      chalk.gray(
        `  Wrapped '${op}' into a one-step ${manifest.actuator_id} pipeline (same shape as ADF).`
      )
    );
  }

  try {
    assertPlaygroundSecretMutationAllowed({
      actuatorId: manifest.actuator_id,
      operation: op,
      params: paramsObject,
      dryRun: options.dryRun,
      check: options.check,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(chalk.red(`\n❌ ${message}`));
    rl.close();
    throw new ScriptExitError(1, message);
  }

  if (options.check === true || options.dryRun === true) {
    // Manifest contract_schema describes the coarse `pipeline` shape only.
    // Single ops merged from describeOps must not be validated against it.
    const plan = evaluatePlaygroundDryRun({
      actuatorId: manifest.actuator_id,
      operation: op,
      payload,
      contractSchemaPath: isManifestOp ? manifest.contract_schema : undefined,
      mode: options.check === true ? 'check' : 'dry-run',
    });
    // `--check` is schema/plan only. Apply/transform/control `--dry-run` also
    // stay validate-only. Capture `--dry-run` falls through and invokes the
    // compiled actuator with `--dry-run` so the capture handler actually runs.
    if (options.check === true || plan.ok === false || plan.handler === 'skipped') {
      rl.close();
      return { ...plan, handler_invoked: false };
    }
  }

  // 7. Write to temp file inside active/shared/tmp/
  const tempDir = pathResolver.sharedTmp('actuator-playground');
  const tempPath = assertSafeRepositoryPath(
    path.join(tempDir, `input-${manifest.actuator_id}-${Date.now()}.json`),
    { allowMissingLeaf: true }
  );

  log(chalk.white(`\nWriting payload to temporary file: ${chalk.bold(tempPath)}...`));
  safeWriteFile(tempPath, JSON.stringify(payload, null, 2), { mkdir: true });

  // 8. Find executable path
  // Standard compile target paths
  const distDir = pathResolver.rootResolve('dist/libs/actuators');
  const execPath1 = assertSafeRepositoryPath(
    path.join(distDir, manifest.actuator_id, 'src/index.js'),
    { allowMissingLeaf: true }
  );
  const execPath2 = assertSafeRepositoryPath(path.join(distDir, manifest.actuator_id, 'index.js'), {
    allowMissingLeaf: true,
  });

  let execPath = options.resolveExecutable?.(manifest.actuator_id) ?? '';
  if (!execPath && safeExistsSync(execPath1)) {
    execPath = execPath1;
  } else if (!execPath && safeExistsSync(execPath2)) {
    execPath = execPath2;
  } else if (!execPath) {
    log(
      chalk.yellow(
        `\n⚠️  Could not find compiled JavaScript under dist/libs/actuators/${manifest.actuator_id}.`
      )
    );
    log(chalk.white('Attempting to compile actuators monorepo-wide first...'));
    try {
      safeExec('pnpm', ['run', 'build:actuators'], { cwd: pathResolver.rootDir() });
      if (safeExistsSync(execPath1)) {
        execPath = execPath1;
      } else if (safeExistsSync(execPath2)) {
        execPath = execPath2;
      }
    } catch (err: any) {
      logError(chalk.red(`❌ Compilation failed: ${err.message}`));
    }
  }

  if (!execPath) {
    logError(chalk.red(`\n❌ Executable not found. Make sure the actuator is built successfully.`));
    rl.close();
    throw new ScriptExitError(1, 'Actuator executable not found');
  }

  // 9. Execute Actuator (capture `--dry-run` still invokes the handler)
  const extraArgs = options.dryRun === true ? ['--dry-run'] : [];
  const executeActuator = options.executeActuator ?? defaultExecuteActuator;
  log(chalk.bold.yellow(`\n⚡ Executing [${manifest.actuator_id}] with command:`));
  log(
    chalk.gray(
      `node ${execPath} --input ${tempPath}${extraArgs.length ? ` ${extraArgs.join(' ')}` : ''}\n`
    )
  );

  try {
    const stdout = executeActuator({ execPath, inputPath: tempPath, extraArgs });
    log(chalk.bold.green('🎉 Execution completed successfully! Result output:'));
    log(chalk.white(stdout.trim()));
    rl.close();
    return {
      ok: true,
      mode: options.dryRun === true ? 'dry-run' : 'execute',
      actuator_id: manifest.actuator_id,
      operation: op,
      kind: resolveCliActionKind(payload),
      dry_run: options.dryRun === true,
      handler: 'capture',
      handler_invoked: true,
      input_path: tempPath,
      executable_path: execPath,
      stdout: stdout.trim(),
    };
  } catch (err: any) {
    logError(chalk.bold.red('\n❌ Execution error encountered:'));
    logError(chalk.red(err.message));
    if (err.stdout) {
      logError(chalk.yellow('\nStdout:'));
      logError(chalk.white(err.stdout.toString().trim()));
    }
    if (err.stderr) {
      logError(chalk.yellow('\nStderr:'));
      logError(chalk.red(err.stderr.toString().trim()));
    }
  }

  rl.close();
}

const script = defineScript({
  name: 'actuator:playground',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, quiet, print }) =>
    runPlayground(stripSharedScriptFlags(argv), { dryRun, check, json, quiet, print }).then(
      (result) => {
        if (result && (json || dryRun || check)) print(result);
        return result;
      }
    ),
});
if (
  isDirectScript(import.meta.url, 'actuator_playground.ts') ||
  isDirectScript(import.meta.url, 'actuator_playground.js')
) {
  void script();
}
