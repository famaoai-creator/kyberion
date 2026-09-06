import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  loadActuatorManifest,
  type ActuatorManifestFile,
} from '@agent/core/actuator-manifest-index';
import { planActuatorDryRun, resolveCliActionKind } from '@agent/core/actuator-sdk';
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

interface PlaygroundRunOptions {
  dryRun?: boolean;
  check?: boolean;
  json?: boolean;
  quiet?: boolean;
  print?: Print;
}

async function runPlayground(
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
  const ops = manifest.capabilities || [];
  let selectedOpObj = ops.find((o) => o.op === targetOp);

  if (!selectedOpObj) {
    if (ops.length === 0) {
      logError(chalk.red(`\n❌ Actuator '${manifest.actuator_id}' defines no capabilities.`));
      rl.close();
      throw new ScriptExitError(1, `Actuator '${manifest.actuator_id}' defines no capabilities`);
    }
    if (machineOutput) {
      rl.close();
      throw new ScriptExitError(1, 'Machine mode requires --op for the selected actuator.');
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
  // Include both 'op' and 'action' for seamless compatibility across different actuator conventions
  const payload = buildPlaygroundPayload(op, paramsObject);

  if (options.dryRun === true || options.check === true) {
    rl.close();
    return evaluatePlaygroundDryRun({
      actuatorId: manifest.actuator_id,
      operation: op,
      payload,
      contractSchemaPath: manifest.contract_schema,
      mode: options.check === true ? 'check' : 'dry-run',
    });
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

  let execPath = '';
  if (safeExistsSync(execPath1)) {
    execPath = execPath1;
  } else if (safeExistsSync(execPath2)) {
    execPath = execPath2;
  } else {
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

  // 9. Execute Actuator
  log(chalk.bold.yellow(`\n⚡ Executing [${manifest.actuator_id}] with command:`));
  log(chalk.gray(`node ${execPath} --input ${tempPath}\n`));

  try {
    const stdout = safeExec('node', [execPath, '--input', tempPath], {
      cwd: pathResolver.rootDir(),
    });
    log(chalk.bold.green('🎉 Execution completed successfully! Result output:'));
    log(chalk.white(stdout.trim()));
    rl.close();
    return {
      ok: true,
      mode: 'execute',
      actuator_id: manifest.actuator_id,
      operation: op,
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
