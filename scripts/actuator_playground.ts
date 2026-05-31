import {
  safeReaddir,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  safeExec,
  pathResolver
} from '@agent/core';
import * as readline from 'node:readline';
import chalk from 'chalk';
import * as path from 'node:path';

interface ActuatorCapability {
  op: string;
  description?: string;
  platforms?: string[];
}

interface ActuatorManifest {
  actuator_id: string;
  version: string;
  description: string;
  capabilities: ActuatorCapability[];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function parseCliArgs() {
  const args = process.argv.slice(2);
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
      return JSON.parse(val);
    } catch (_) {
      // Fallback to string if parsing fails
    }
  }
  return val;
}

async function runPlayground() {
  console.log(chalk.bold.cyan('\n🛠️  [KYBERION] Actuator Playground CLI\n'));

  // 1. Scan available actuators
  const actuatorsDir = pathResolver.rootResolve('libs/actuators');
  const dirEntries = safeReaddir(actuatorsDir);
  const actuators: { id: string; manifestPath: string; manifest: ActuatorManifest }[] = [];

  for (const entry of dirEntries) {
    const entryPath = path.join(actuatorsDir, entry);
    const manifestPath = path.join(entryPath, 'manifest.json');
    if (safeExistsSync(manifestPath)) {
      try {
        const raw = safeReadFile(manifestPath, { encoding: 'utf8' }) as string;
        const manifest = JSON.parse(raw) as ActuatorManifest;
        if (manifest && manifest.actuator_id) {
          actuators.push({
            id: entry,
            manifestPath,
            manifest
          });
        }
      } catch (err: any) {
        // Skip invalid manifests
      }
    }
  }

  if (actuators.length === 0) {
    console.log(chalk.red('❌ No valid actuators with manifest.json found in libs/actuators/'));
    rl.close();
    process.exit(1);
  }

  // 2. Parse CLI args for non-interactive mode
  const cliParams = parseCliArgs();
  let targetActuatorId = cliParams.actuator;
  let targetOp = cliParams.op;
  let rawParamsStr = cliParams.params;

  let selectedActuator = actuators.find(a => a.id === targetActuatorId || a.manifest.actuator_id === targetActuatorId);

  // 3. Actuator Selection Wizard
  if (!selectedActuator) {
    console.log(chalk.white('Available Actuators:'));
    actuators.forEach((act, idx) => {
      console.log(`  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(act.manifest.actuator_id)} (v${act.manifest.version})`);
      console.log(`     ${chalk.gray(act.manifest.description)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Actuator by number: '));
    const idx = parseInt(choiceStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actuators.length) {
      console.error(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      process.exit(1);
    }
    selectedActuator = actuators[idx];
  }

  const manifest = selectedActuator.manifest;
  console.log(chalk.green(`\n✓ Selected Actuator: ${chalk.bold(manifest.actuator_id)}`));

  // 4. Operation Selection Wizard
  const ops = manifest.capabilities || [];
  let selectedOpObj = ops.find(o => o.op === targetOp);

  if (!selectedOpObj) {
    if (ops.length === 0) {
      console.error(chalk.red(`\n❌ Actuator '${manifest.actuator_id}' defines no capabilities.`));
      rl.close();
      process.exit(1);
    }

    console.log(chalk.white('\nAvailable Operations (ops):'));
    ops.forEach((opObj, idx) => {
      const desc = opObj.description ? ` - ${opObj.description}` : '';
      console.log(`  ${chalk.bold.cyan(idx + 1)}. ${chalk.bold(opObj.op)}${chalk.gray(desc)}`);
    });

    const choiceStr = await question(chalk.bold.blue('\nSelect an Operation by number: '));
    const idx = parseInt(choiceStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= ops.length) {
      console.error(chalk.red('\n❌ Invalid selection.'));
      rl.close();
      process.exit(1);
    }
    selectedOpObj = ops[idx];
  }

  const op = selectedOpObj.op;
  console.log(chalk.green(`✓ Selected Operation: ${chalk.bold(op)}`));

  // 5. Parameter Gathering Wizard
  let paramsObject: Record<string, any> = {};

  if (rawParamsStr) {
    try {
      paramsObject = JSON.parse(rawParamsStr);
    } catch (err: any) {
      console.error(chalk.red(`\n❌ Failed to parse --params JSON: ${err.message}`));
      rl.close();
      process.exit(1);
    }
  } else {
    console.log(chalk.white('\nHow would you like to provide the operation parameters?'));
    console.log(chalk.cyan('  1. Interactive Wizard (key-value prompting)'));
    console.log(chalk.cyan('  2. Paste Raw JSON block'));

    const methodChoice = await question(chalk.bold.blue('\nChoose method (1 or 2): '));

    if (methodChoice === '2') {
      console.log(chalk.yellow('\nPaste the full JSON value for "params" (e.g. {"channel": "slack", "text": "hello"}):'));
      const jsonStr = await question('> ');
      try {
        paramsObject = JSON.parse(jsonStr);
      } catch (err: any) {
        console.error(chalk.red(`❌ Invalid JSON block: ${err.message}`));
        rl.close();
        process.exit(1);
      }
    } else {
      console.log(chalk.yellow('\nEnter parameter key-value pairs one by one. Leave key empty to finish.'));
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
  const payload = {
    action: op,
    op: op,
    params: paramsObject
  };

  // 7. Write to temp file inside active/shared/tmp/
  const tempDir = pathResolver.sharedTmp('actuator-playground');
  const tempPath = path.join(tempDir, `input-${manifest.actuator_id}-${Date.now()}.json`);

  console.log(chalk.white(`\nWriting payload to temporary file: ${chalk.bold(tempPath)}...`));
  safeWriteFile(tempPath, JSON.stringify(payload, null, 2), { mkdir: true });

  // 8. Find executable path
  // Standard compile target paths
  const distDir = pathResolver.rootResolve('dist/libs/actuators');
  const execPath1 = path.join(distDir, manifest.actuator_id, 'src/index.js');
  const execPath2 = path.join(distDir, manifest.actuator_id, 'index.js');

  let execPath = '';
  if (safeExistsSync(execPath1)) {
    execPath = execPath1;
  } else if (safeExistsSync(execPath2)) {
    execPath = execPath2;
  } else {
    console.log(chalk.yellow(`\n⚠️  Could not find compiled JavaScript under dist/libs/actuators/${manifest.actuator_id}.`));
    console.log(chalk.white('Attempting to compile actuators monorepo-wide first...'));
    try {
      safeExec('pnpm', ['run', 'build:actuators'], { cwd: pathResolver.rootDir() });
      if (safeExistsSync(execPath1)) {
        execPath = execPath1;
      } else if (safeExistsSync(execPath2)) {
        execPath = execPath2;
      }
    } catch (err: any) {
      console.error(chalk.red(`❌ Compilation failed: ${err.message}`));
    }
  }

  if (!execPath) {
    console.error(chalk.red(`\n❌ Executable not found. Make sure the actuator is built successfully.`));
    rl.close();
    process.exit(1);
  }

  // 9. Execute Actuator
  console.log(chalk.bold.yellow(`\n⚡ Executing [${manifest.actuator_id}] with command:`));
  console.log(chalk.gray(`node ${execPath} --input ${tempPath}\n`));

  try {
    const stdout = safeExec('node', [execPath, '--input', tempPath], {
      cwd: pathResolver.rootDir()
    });
    console.log(chalk.bold.green('🎉 Execution completed successfully! Result output:'));
    console.log(chalk.white(stdout.trim()));
  } catch (err: any) {
    console.error(chalk.bold.red('\n❌ Execution error encountered:'));
    console.error(chalk.red(err.message));
    if (err.stdout) {
      console.error(chalk.yellow('\nStdout:'));
      console.error(chalk.white(err.stdout.toString().trim()));
    }
    if (err.stderr) {
      console.error(chalk.yellow('\nStderr:'));
      console.error(chalk.red(err.stderr.toString().trim()));
    }
  }

  rl.close();
}

runPlayground().catch(err => {
  console.error(chalk.red(`\n❌ Critical Error: ${err.message}`));
  rl.close();
  process.exit(1);
});
