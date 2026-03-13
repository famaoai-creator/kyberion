import { logger, pathResolver, safeExistsSync, safeExec, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';
import chalk from 'chalk';

interface RawSkillEntry {
  n?: string;
  name?: string;
  path: string;
  d?: string;
  description?: string;
  s?: string;
  status?: string;
}

interface RawSkillIndex {
  s?: RawSkillEntry[];
  skills?: RawSkillEntry[];
}

export interface SkillRecord {
  name: string;
  path: string;
  description: string;
  status: string;
}

const rootDir = pathResolver.rootDir();
const indexCandidates = [
  pathResolver.knowledge('public/orchestration/global_skill_index.json'),
  pathResolver.knowledge('orchestration/global_skill_index.json'),
];

export function resolveIndexPath(): string {
  const resolved = indexCandidates.find(candidate => safeExistsSync(candidate));
  if (!resolved) {
    throw new Error(`Skill index not found. Checked: ${indexCandidates.join(', ')}`);
  }

  return resolved;
}

export function normalizeSkills(index: RawSkillIndex): SkillRecord[] {
  const rawSkills = index.s || index.skills || [];

  return rawSkills
    .map(skill => ({
      name: skill.n || skill.name || path.basename(skill.path),
      path: skill.path,
      description: skill.d || skill.description || 'No description available.',
      status: skill.s || skill.status || 'unknown',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkills(): SkillRecord[] {
  const indexContent = safeReadFile(resolveIndexPath(), { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(indexContent) as RawSkillIndex;
  return normalizeSkills(parsed);
}

export function searchSkills(skills: SkillRecord[], query: string): SkillRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return skills;
  }

  return skills.filter(skill =>
    skill.name.toLowerCase().includes(normalizedQuery) ||
    skill.description.toLowerCase().includes(normalizedQuery) ||
    skill.path.toLowerCase().includes(normalizedQuery),
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

function printHelp(skills: SkillRecord[]) {
  printHeader();
  console.log('Usage: npm run cli -- <command> [arguments]');
  console.log('');
  console.log('Commands:');
  console.log('  help                 Show this help');
  console.log('  list                 List available actuators in the global skill index');
  console.log('  search <query>       Search actuators by name, description, or path');
  console.log('  info <name>          Show details for a specific actuator');
  console.log('  run <name> [args]    Execute an actuator, forwarding trailing arguments');
  console.log('');
  console.log('Examples:');
  console.log('  npm run cli -- list');
  console.log('  npm run cli -- search browser');
  console.log('  npm run cli -- info orchestrator-actuator');
  console.log('  npm run cli -- run file-actuator -- --help');
  console.log('');
  console.log('Useful first-run commands:');
  console.log('  pnpm onboard         Configure sovereign identity');
  console.log('  pnpm capabilities    Check which actuator capabilities fit this environment');
  console.log('  pnpm mission:journal Inspect mission history');
  console.log('');
  console.log(`Indexed actuators: ${skills.length}`);
}

function printSkillList(skills: SkillRecord[]) {
  printHeader();

  if (skills.length === 0) {
    console.log('No actuators were found in the skill index.');
    return;
  }

  console.log(`Indexed actuators: ${skills.length}\n`);
  skills.forEach(skill => {
    console.log(`- ${chalk.bold(skill.name)} (${skill.status})`);
    console.log(`  ${skill.description}`);
    console.log(`  ${chalk.gray(skill.path)}`);
  });
}

function printSkillInfo(skill: SkillRecord) {
  printHeader();
  console.log(`${chalk.bold(skill.name)} (${skill.status})`);
  console.log(skill.description);
  console.log(`Path: ${skill.path}`);

  const runnableScript = resolveSkillPath(skill.path);
  console.log(`Runnable: ${runnableScript ? runnableScript : 'Not built yet (run pnpm build)'}`);
}

export function resolveSkillPath(skillPath: string): string | null {
  const candidates = [
    path.join(rootDir, 'dist', skillPath, 'src'),
    path.join(rootDir, 'dist', 'skills', skillPath, 'src'),
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

function findSkill(skills: SkillRecord[], name: string): SkillRecord | undefined {
  const normalizedName = name.trim().toLowerCase();
  return skills.find(skill => skill.name.toLowerCase() === normalizedName);
}

function runSkill(skills: SkillRecord[], skillName: string | undefined, rawArgs: string[], missionId?: string) {
  if (!skillName) {
    throw new Error('Missing actuator name. Try `npm run cli -- list`.');
  }

  const skill = findSkill(skills, skillName);
  if (!skill) {
    const suggestions = searchSkills(skills, skillName).slice(0, 5).map(match => match.name);
    const suffix = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    throw new Error(`Actuator "${skillName}" not found.${suffix}`);
  }

  const { branchId, args } = extractBranchArg(rawArgs);
  printBranchBanner(branchId);

  const script = resolveSkillPath(skill.path);
  if (!script) {
    throw new Error(`Actuator "${skill.name}" is indexed but has no runnable build output. Run \`pnpm build\` first.`);
  }

  const forwardedArgs = args.filter(arg => arg !== '--');
  process.stderr.write(chalk.blue(`🚀 ACTUATING: ${skill.name}...\n`));

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

  const skills = loadSkills();
  const [command = 'help', firstArg, ...restArgs] = args;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(skills);
    return;
  }

  if (command === 'list') {
    printSkillList(skills);
    return;
  }

  if (command === 'search') {
    const matches = searchSkills(skills, firstArg || '');
    printSkillList(matches);
    return;
  }

  if (command === 'info') {
    if (!firstArg) {
      throw new Error('Missing actuator name. Try `npm run cli -- list`.');
    }

    const skill = findSkill(skills, firstArg);
    if (!skill) {
      throw new Error(`Actuator "${firstArg}" not found.`);
    }

    printSkillInfo(skill);
    return;
  }

  if (command === 'run') {
    runSkill(skills, firstArg, restArgs, missionId);
    return;
  }

  throw new Error(`Unknown command "${command}". Try \`npm run cli -- help\`.`);
}

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
