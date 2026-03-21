import { logger, pathResolver, safeExistsSync, safeExec, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

interface RawActuatorEntry {
  n?: string;
  name?: string;
  path: string;
  d?: string;
  description?: string;
  s?: string;
  status?: string;
}

interface RawActuatorIndex {
  s?: RawActuatorEntry[];
  actuators?: RawActuatorEntry[];
  skills?: RawActuatorEntry[];
}

interface ActuatorExampleRecord {
  id: string;
  title: string;
  path: string;
  description: string;
  tags?: string[];
}

interface ActuatorExampleCatalog {
  actuator: string;
  examples: ActuatorExampleRecord[];
}

export interface ActuatorRecord {
  name: string;
  path: string;
  description: string;
  status: string;
}

const rootDir = pathResolver.rootDir();
const indexCandidates = [
  pathResolver.knowledge('public/orchestration/global_actuator_index.json'),
  pathResolver.knowledge('orchestration/global_actuator_index.json'),
];

export function resolveIndexPath(): string {
  const resolved = indexCandidates.find(candidate => safeExistsSync(candidate));
  if (!resolved) {
    throw new Error(`Actuator index not found. Checked: ${indexCandidates.join(', ')}`);
  }

  return resolved;
}

export function normalizeActuators(index: RawActuatorIndex): ActuatorRecord[] {
  const rawActuators = index.actuators || index.s || index.skills || [];

  return rawActuators
    .map(actuator => ({
      name: actuator.n || actuator.name || path.basename(actuator.path),
      path: actuator.path,
      description: actuator.d || actuator.description || 'No description available.',
      status: actuator.s || actuator.status || 'unknown',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadActuators(): ActuatorRecord[] {
  const indexContent = safeReadFile(resolveIndexPath(), { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(indexContent) as RawActuatorIndex;
  return normalizeActuators(parsed);
}

export function searchActuators(actuators: ActuatorRecord[], query: string): ActuatorRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return actuators;
  }

  return actuators.filter(actuator =>
    actuator.name.toLowerCase().includes(normalizedQuery) ||
    actuator.description.toLowerCase().includes(normalizedQuery) ||
    actuator.path.toLowerCase().includes(normalizedQuery),
  );
}

export function extractBranchArg(args: string[]): { branchId?: string; args: string[] } {
  const nextArgs = [...args];
  const branchIndex = nextArgs.indexOf('--branch');

  if (branchIndex === -1) {
    return { args: nextArgs };
  }

  const branchId = nextArgs[branchIndex + 1];
  nextArgs.splice(branchIndex, branchId ? 2 : 1);

  return { branchId, args: nextArgs };
}

function printMissionContextBanner(missionId?: string) {
  if (!missionId) {
    return;
  }

  const statePath = path.join(rootDir, 'active/missions', missionId, 'mission-state.json');
  if (!safeExistsSync(statePath)) {
    return;
  }

  try {
    const stateContent = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    const state = JSON.parse(stateContent) as { status?: string };
    process.stderr.write(chalk.cyan(`\n🧠 BRAIN: Context hydrated from mission "${missionId}" (Status: ${state.status || 'unknown'})\n`));
  } catch {
    // Keep the console usable even if mission metadata is malformed.
  }
}

function printBranchBanner(branchId?: string) {
  if (!branchId) {
    return;
  }

  const patchPath = path.join(rootDir, 'knowledge/evolution/latent-wisdom', `${branchId}.json`);
  if (!safeExistsSync(patchPath)) {
    process.stderr.write(chalk.red(`\n❌ Error: Branch "${branchId}" not found in Wisdom Vault.\n`));
    return;
  }

  process.stderr.write(chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"\n`));
}

function printHeader() {
  console.log(chalk.yellow('\n🌌 KYBERION CONSOLE v2.2 [SECURE-IO ENFORCED]'));
  console.log(chalk.gray('Discover, inspect, and run actuators from the sovereign console.\n'));
}

function printHelp(actuators: ActuatorRecord[]) {
  printHeader();
  console.log('Usage: npm run cli -- <command> [arguments]');
  console.log('');
  console.log('Commands:');
  console.log('  help                 Show this help');
  console.log('  list                 List available actuators in the global actuator index');
  console.log('  search <query>       Search actuators by name, description, or path');
  console.log('  info <name>          Show details for a specific actuator');
  console.log('  examples <name>      List actuator-owned examples for a specific actuator');
  console.log('  run <name> [args]    Execute an actuator, forwarding trailing arguments');
  console.log('');
  console.log('Examples:');
  console.log('  npm run cli -- list');
  console.log('  npm run cli -- search browser');
  console.log('  npm run cli -- info orchestrator-actuator');
  console.log('  npm run cli -- examples browser-actuator');
  console.log('  npm run cli -- run file-actuator -- --help');
  console.log('');
  console.log('Useful first-run commands:');
  console.log('  pnpm onboard         Configure sovereign identity');
  console.log('  pnpm capabilities    Check which actuator capabilities fit this environment');
  console.log('  pnpm mission:journal Inspect mission history');
  console.log('');
  console.log(`Indexed actuators: ${actuators.length}`);
}

function printActuatorList(actuators: ActuatorRecord[]) {
  printHeader();

  if (actuators.length === 0) {
    console.log('No actuators were found in the actuator index.');
    return;
  }

  console.log(`Indexed actuators: ${actuators.length}\n`);
  actuators.forEach(actuator => {
    console.log(`- ${chalk.bold(actuator.name)} (${actuator.status})`);
    console.log(`  ${actuator.description}`);
    console.log(`  ${chalk.gray(actuator.path)}`);
  });
}

function printActuatorExampleSummary(actuators: ActuatorRecord[]) {
  printHeader();
  console.log('Actuator-owned examples\n');

  let totalExamples = 0;
  for (const actuator of actuators) {
    const examples = loadActuatorExamples(actuator);
    if (examples.length === 0) continue;
    totalExamples += examples.length;
    console.log(`- ${chalk.bold(actuator.name)} (${examples.length})`);
    console.log(`  ${examples.map(example => example.id).join(', ')}`);
  }

  if (totalExamples === 0) {
    console.log('No actuator-owned examples found.');
    return;
  }

  console.log(`\nTotal examples: ${totalExamples}`);
}

function printActuatorInfo(actuator: ActuatorRecord) {
  printHeader();
  console.log(`${chalk.bold(actuator.name)} (${actuator.status})`);
  console.log(actuator.description);
  console.log(`Path: ${actuator.path}`);

  const runnableScript = resolveActuatorPath(actuator.path);
  console.log(`Runnable: ${runnableScript ? runnableScript : 'Not built yet (run pnpm build)'}`);
  const examples = loadActuatorExamples(actuator);
  console.log(`Examples: ${examples.length}`);
}

function resolveActuatorExamplesCatalogPath(actuator: ActuatorRecord): string {
  return path.join(rootDir, actuator.path, 'examples', 'catalog.json');
}

function loadActuatorExamples(actuator: ActuatorRecord): ActuatorExampleRecord[] {
  const catalogPath = resolveActuatorExamplesCatalogPath(actuator);
  if (!safeExistsSync(catalogPath)) {
    return [];
  }

  const content = safeReadFile(catalogPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(content) as ActuatorExampleCatalog;
  return Array.isArray(parsed.examples) ? parsed.examples : [];
}

function printActuatorExamples(actuator: ActuatorRecord) {
  printHeader();
  const examples = loadActuatorExamples(actuator);
  console.log(`${chalk.bold(actuator.name)} examples\n`);

  if (examples.length === 0) {
    console.log('No actuator-owned examples found.');
    return;
  }

  examples.forEach(example => {
    console.log(`- ${chalk.bold(example.id)}: ${example.title}`);
    console.log(`  ${example.description}`);
    console.log(`  ${chalk.gray(example.path)}`);
    console.log(`  run: node dist/${actuator.path}/src/index.js --input ${example.path}`);
    if (example.tags?.length) {
      console.log(`  tags: ${example.tags.join(', ')}`);
    }
  });
}

export function resolveActuatorPath(actuatorPath: string): string | null {
  const candidates = [
    path.join(rootDir, 'dist', actuatorPath, 'src'),
  ];

  for (const candidate of candidates) {
    if (!safeExistsSync(candidate)) {
      continue;
    }

    const files = safeReaddir(candidate);
    const main = files.find(file => file === 'index.js' || file === 'main.js');
    if (main) {
      return path.join(candidate, main);
    }
  }

  return null;
}

function findActuator(actuators: ActuatorRecord[], name: string): ActuatorRecord | undefined {
  const normalizedName = name.trim().toLowerCase();
  return actuators.find(actuator => actuator.name.toLowerCase() === normalizedName);
}

function runActuator(actuators: ActuatorRecord[], actuatorName: string | undefined, rawArgs: string[], missionId?: string) {
  if (!actuatorName) {
    throw new Error('Missing actuator name. Try `npm run cli -- list`.');
  }

  const actuator = findActuator(actuators, actuatorName);
  if (!actuator) {
    const suggestions = searchActuators(actuators, actuatorName).slice(0, 5).map(match => match.name);
    const suffix = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    throw new Error(`Actuator "${actuatorName}" not found.${suffix}`);
  }

  const { branchId, args } = extractBranchArg(rawArgs);
  printBranchBanner(branchId);

  const script = resolveActuatorPath(actuator.path);
  if (!script) {
    throw new Error(`Actuator "${actuator.name}" is indexed but has no runnable build output. Run \`pnpm build\` first.`);
  }

  const forwardedArgs = args.filter(arg => arg !== '--');
  process.stderr.write(chalk.blue(`🚀 ACTUATING: ${actuator.name}...\n`));

  try {
    const output = safeExec('node', [script, ...forwardedArgs], {
      env: { ...process.env, MISSION_ID: missionId || '' },
    });

    if (output) {
      process.stdout.write(output);
    }
  } catch (err: any) {
    process.stderr.write(chalk.red(`\n❌ Execution failed: ${err.message}\n`));
    if (err.stdout) {
      process.stdout.write(err.stdout.toString());
    }
    throw err;
  }
}

export async function main(args = process.argv.slice(2)) {
  const missionId = process.env.MISSION_ID;
  printMissionContextBanner(missionId);

  const actuators = loadActuators();
  const [command = 'help', firstArg, ...restArgs] = args;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(actuators);
    return;
  }

  if (command === 'list') {
    printActuatorList(actuators);
    return;
  }

  if (command === 'search') {
    const matches = searchActuators(actuators, firstArg || '');
    printActuatorList(matches);
    return;
  }

  if (command === 'info') {
    if (!firstArg) {
      throw new Error('Missing actuator name. Try `npm run cli -- list`.');
    }

    const actuator = findActuator(actuators, firstArg);
    if (!actuator) {
      throw new Error(`Actuator "${firstArg}" not found.`);
    }

    printActuatorInfo(actuator);
    return;
  }

  if (command === 'examples') {
    if (!firstArg) {
      printActuatorExampleSummary(actuators);
      return;
    }

    const actuator = findActuator(actuators, firstArg);
    if (!actuator) {
      throw new Error(`Actuator "${firstArg}" not found.`);
    }

    printActuatorExamples(actuator);
    return;
  }

  if (command === 'run') {
    runActuator(actuators, firstArg, restArgs, missionId);
    return;
  }

  throw new Error(`Unknown command "${command}". Try \`npm run cli -- help\`.`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
