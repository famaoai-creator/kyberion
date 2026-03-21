import {
  logger,
  pathResolver,
  safeExistsSync,
  safeExec,
  safeReadFile,
  safeReaddir,
  safeStat,
  assertValidMobileAppProfileIndex,
  assertValidWebAppProfileIndex,
} from '@agent/core';
import type { MobileAppProfileIndex } from '@agent/core';
import * as path from 'node:path';
import * as os from 'node:os';
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

interface OperatorPacketAction {
  id: string;
  priority?: 'now' | 'next' | 'later';
  action: string;
  reason?: string;
  suggested_command?: string;
  suggested_pipeline_path?: string;
  suggested_followup_request?: string;
}

interface OperatorInteractionPacket {
  kind: 'operator-interaction-packet';
  interaction_type: 'clarification' | 'execution-preview' | 'status-summary' | 'delivery-summary';
  headline: string;
  summary: string;
  readiness?: string;
  confidence?: number;
  questions?: Array<{
    id: string;
    question: string;
    reason: string;
    default_assumption?: string;
    impact?: string;
  }>;
  next_actions?: OperatorPacketAction[];
  suggested_response_style?: 'clarify-first' | 'preview-and-confirm' | 'status-summary';
  refresh_command?: string;
  refresh_packet_path?: string;
}

interface SystemStatusReportLike {
  kind: 'system-status-report';
  headline: string;
  summary: string;
  findings?: Array<{ id: string; severity: string; message: string; detail?: string }>;
  next_actions?: OperatorPacketAction[];
}

interface OperatorResponsePreview {
  kind: 'operator-response-preview';
  format: 'plain-text';
  text: string;
}

export interface ActuatorRecord {
  name: string;
  path: string;
  description: string;
  status: string;
}

type MobileAppProfileRecord = MobileAppProfileIndex['profiles'][number];
interface WebAppProfileIndexRecord {
  id: string;
  platform: 'browser';
  title: string;
  path: string;
  description: string;
  tags?: string[];
}

const rootDir = pathResolver.rootDir();
const vocabularyPath = pathResolver.knowledge('public/orchestration/user-facing-vocabulary.json');
const indexCandidates = [
  pathResolver.knowledge('public/orchestration/global_actuator_index.json'),
  pathResolver.knowledge('orchestration/global_actuator_index.json'),
];

type VocabularyCatalog = {
  default_locale: string;
  domains?: Record<string, Record<string, Record<string, string>>>;
};

function resolveLocale(args: string[] = process.argv.slice(2)): string {
  const localeArgIndex = args.indexOf('--locale');
  const localeArg = localeArgIndex >= 0 ? args[localeArgIndex + 1] : '';
  const envLocale = process.env.KYBERION_UI_LOCALE || process.env.LANG || '';
  const rawLocale = String(localeArg || envLocale || 'en').trim();
  const normalized = rawLocale.replace(/_/g, '-').toLowerCase();
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
}

function stripLocaleArg(args: string[]): string[] {
  const nextArgs = [...args];
  const localeArgIndex = nextArgs.indexOf('--locale');
  if (localeArgIndex === -1) {
    return nextArgs;
  }
  nextArgs.splice(localeArgIndex, nextArgs[localeArgIndex + 1] ? 2 : 1);
  return nextArgs;
}

function loadVocabularyCatalog(): VocabularyCatalog | null {
  if (!safeExistsSync(vocabularyPath)) {
    return null;
  }
  try {
    return JSON.parse(safeReadFile(vocabularyPath, { encoding: 'utf8' }) as string) as VocabularyCatalog;
  } catch {
    return null;
  }
}

function t(key: string, locale = resolveLocale()): string {
  const catalog = loadVocabularyCatalog();
  const entry = catalog?.domains?.ux?.[key];
  if (!entry) return key;
  return entry[locale] || entry[catalog?.default_locale || 'en'] || key;
}

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
  console.log('  mobile-profiles [id] List shared mobile app profiles or inspect one profile');
  console.log('  web-profiles [id]    List shared web app profiles or inspect one profile');
  console.log('  artifact <path>      Inspect a generated artifact for review');
  console.log('  open-artifact <path> Open a generated artifact with the local viewer');
  console.log('  packet <path>        Render an operator packet, status report, or response preview');
  console.log('  accept-next-action <packet> <id>  Execute a suggested next action from a packet');
  console.log('  run <name> [args]    Execute an actuator, forwarding trailing arguments');
  console.log('');
  console.log('Examples:');
  console.log('  npm run cli -- list');
  console.log('  npm run cli -- search browser');
  console.log('  npm run cli -- info orchestrator-actuator');
  console.log('  npm run cli -- examples browser-actuator');
  console.log('  npm run cli -- mobile-profiles');
  console.log('  npm run cli -- web-profiles');
  console.log('  npm run cli -- artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx');
  console.log('  npm run cli -- open-artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx');
  console.log('  npm run cli -- packet active/shared/tmp/orchestrator/operator-interaction-packet.json');
  console.log('  npm run cli -- accept-next-action active/shared/tmp/orchestrator/status-operator-interaction-packet.json review-target-mission-artifacts');
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

function resolveMobileAppProfileIndexPath(): string {
  return pathResolver.knowledge('public/orchestration/mobile-app-profiles/index.json');
}

function loadMobileAppProfiles(): MobileAppProfileRecord[] {
  const indexPath = resolveMobileAppProfileIndexPath();
  if (!safeExistsSync(indexPath)) {
    return [];
  }
  const content = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(content) as MobileAppProfileIndex;
  assertValidMobileAppProfileIndex(parsed, indexPath, (relativePath) => safeExistsSync(path.join(rootDir, relativePath)));
  return parsed.profiles;
}

function printMobileAppProfilesSummary() {
  printHeader();
  const profiles = loadMobileAppProfiles();
  console.log('Mobile app profiles\n');

  if (profiles.length === 0) {
    console.log('No shared mobile app profiles found.');
    return;
  }

  profiles.forEach(profile => {
    console.log(`- ${chalk.bold(profile.id)} (${profile.platform})`);
    console.log(`  ${profile.title}`);
    console.log(`  ${profile.description}`);
    console.log(`  ${chalk.gray(profile.path)}`);
    if (profile.tags?.length) {
      console.log(`  tags: ${profile.tags.join(', ')}`);
    }
  });
}

function printMobileAppProfile(profileId: string) {
  const profiles = loadMobileAppProfiles();
  const profile = profiles.find(entry => entry.id === profileId);
  if (!profile) {
    throw new Error(`Mobile app profile "${profileId}" not found.`);
  }

  printHeader();
  console.log(`${chalk.bold(profile.id)} (${profile.platform})`);
  console.log(profile.title);
  console.log(profile.description);
  console.log(`Path: ${profile.path}`);
  if (profile.tags?.length) {
    console.log(`Tags: ${profile.tags.join(', ')}`);
  }
}

function resolveWebAppProfileIndexPath(): string {
  return pathResolver.knowledge('public/orchestration/web-app-profiles/index.json');
}

function loadWebAppProfiles(): WebAppProfileIndexRecord[] {
  const indexPath = resolveWebAppProfileIndexPath();
  if (!safeExistsSync(indexPath)) {
    return [];
  }
  const content = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(content) as { profiles: WebAppProfileIndexRecord[] };
  assertValidWebAppProfileIndex(parsed, indexPath, (relativePath) => safeExistsSync(path.join(rootDir, relativePath)));
  return parsed.profiles;
}

function printWebAppProfilesSummary() {
  printHeader();
  const profiles = loadWebAppProfiles();
  console.log('Web app profiles\n');

  if (profiles.length === 0) {
    console.log('No shared web app profiles found.');
    return;
  }

  profiles.forEach(profile => {
    console.log(`- ${chalk.bold(profile.id)} (${profile.platform})`);
    console.log(`  ${profile.title}`);
    console.log(`  ${profile.description}`);
    console.log(`  ${chalk.gray(profile.path)}`);
    if (profile.tags?.length) {
      console.log(`  tags: ${profile.tags.join(', ')}`);
    }
  });
}

function printWebAppProfile(profileId: string) {
  const profiles = loadWebAppProfiles();
  const profile = profiles.find(entry => entry.id === profileId);
  if (!profile) {
    throw new Error(`Web app profile "${profileId}" not found.`);
  }

  printHeader();
  console.log(`${chalk.bold(profile.id)} (${profile.platform})`);
  console.log(profile.title);
  console.log(profile.description);
  console.log(`Path: ${profile.path}`);
  if (profile.tags?.length) {
    console.log(`Tags: ${profile.tags.join(', ')}`);
  }
}

function printArtifactInfo(targetPath: string) {
  const resolvedPath = path.resolve(rootDir, targetPath);
  if (!safeExistsSync(resolvedPath)) {
    throw new Error(`Artifact not found: ${targetPath}`);
  }
  const stat = safeStat(resolvedPath);
  const ext = path.extname(resolvedPath).toLowerCase();
  printHeader();
  console.log(chalk.bold(path.basename(resolvedPath)));
  console.log(`Path: ${targetPath}`);
  console.log(`Size: ${stat.size} bytes`);
  console.log(`Modified: ${stat.mtime.toISOString()}`);
  if (['.json', '.md', '.txt', '.log', '.adf', '.xml', '.yaml', '.yml'].includes(ext)) {
    const content = safeReadFile(resolvedPath, { encoding: 'utf8' }) as string;
    const preview = content.split('\n').slice(0, 40).join('\n');
    console.log('\nPreview:\n');
    console.log(preview);
    if (content.split('\n').length > 40) {
      console.log('\n... truncated ...');
    }
    return;
  }
  console.log('\nBinary artifact. Review this path with an appropriate local viewer if needed.');
}

function resolveOpenArtifactCommand(targetPath: string): { command: string; args: string[] } {
  const platform = os.platform();
  if (platform === 'darwin') {
    return { command: 'open', args: [targetPath] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', targetPath] };
  }
  return { command: 'xdg-open', args: [targetPath] };
}

function openArtifact(targetPath: string) {
  const resolvedPath = path.resolve(rootDir, targetPath);
  if (!safeExistsSync(resolvedPath)) {
    throw new Error(`Artifact not found: ${targetPath}`);
  }
  const opener = resolveOpenArtifactCommand(resolvedPath);
  printHeader();
  console.log(chalk.bold(path.basename(resolvedPath)));
  console.log(`Opening: ${targetPath}`);
  console.log(`Command: ${[opener.command, ...opener.args].join(' ')}\n`);
  safeExec(opener.command, opener.args, { cwd: rootDir, timeoutMs: 120000 });
}

function printOperatorPacket(packet: OperatorInteractionPacket) {
  const locale = resolveLocale();
  printHeader();
  console.log(chalk.bold(packet.headline));
  console.log(packet.summary);
  if (packet.readiness) {
    console.log(`${locale === 'ja' ? '実行準備度' : 'Readiness'}: ${packet.readiness}`);
  }
  if (typeof packet.confidence === 'number') {
    console.log(`${locale === 'ja' ? '確信度' : 'Confidence'}: ${packet.confidence}`);
  }
  if (packet.suggested_response_style) {
    console.log(`${locale === 'ja' ? '応答スタイル' : 'Response style'}: ${packet.suggested_response_style}`);
  }
  if (packet.questions?.length) {
    console.log(`\n${locale === 'ja' ? '質問' : 'Questions'}:`);
    packet.questions.forEach(question => {
      console.log(`- ${chalk.bold(question.id)}: ${question.question}`);
      console.log(`  ${locale === 'ja' ? '理由' : 'reason'}: ${question.reason}`);
      if (question.default_assumption) console.log(`  ${locale === 'ja' ? '既定' : 'default'}: ${question.default_assumption}`);
      if (question.impact) console.log(`  ${locale === 'ja' ? '影響' : 'impact'}: ${question.impact}`);
    });
  }
  if (packet.next_actions?.length) {
    console.log(`\n${locale === 'ja' ? '次アクション' : 'Next actions'}:`);
    packet.next_actions.forEach(action => {
      console.log(`- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}: ${action.action}`);
      if (action.reason) console.log(`  ${locale === 'ja' ? '理由' : 'reason'}: ${action.reason}`);
      if (action.suggested_command) console.log(`  ${locale === 'ja' ? 'コマンド' : 'command'}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path) console.log(`  ${locale === 'ja' ? 'パイプライン' : 'pipeline'}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request) console.log(`  ${locale === 'ja' ? '追加入力依頼' : 'follow-up'}: ${action.suggested_followup_request}`);
    });
  }
}

function printSystemStatusReport(report: SystemStatusReportLike) {
  const locale = resolveLocale();
  printHeader();
  console.log(chalk.bold(report.headline));
  console.log(report.summary);
  if (report.findings?.length) {
    console.log(`\n${locale === 'ja' ? '所見' : 'Findings'}:`);
    report.findings.forEach(finding => {
      console.log(`- ${chalk.bold(finding.id)} [${finding.severity}]: ${finding.message}`);
      if (finding.detail) console.log(`  ${locale === 'ja' ? '詳細' : 'detail'}: ${finding.detail}`);
    });
  }
  if (report.next_actions?.length) {
    console.log(`\n${locale === 'ja' ? '次アクション' : 'Next actions'}:`);
    report.next_actions.forEach(action => {
      console.log(`- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}: ${action.action}`);
      if (action.reason) console.log(`  ${locale === 'ja' ? '理由' : 'reason'}: ${action.reason}`);
      if (action.suggested_command) console.log(`  ${locale === 'ja' ? 'コマンド' : 'command'}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path) console.log(`  ${locale === 'ja' ? 'パイプライン' : 'pipeline'}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request) console.log(`  ${locale === 'ja' ? '追加入力依頼' : 'follow-up'}: ${action.suggested_followup_request}`);
    });
  }
}

function printResponsePreview(preview: OperatorResponsePreview) {
  printHeader();
  console.log(preview.text);
}

function loadPacketFile(targetPath: string): { kind?: string } {
  const resolvedPath = path.resolve(rootDir, targetPath);
  if (!safeExistsSync(resolvedPath)) {
    throw new Error(`Packet file not found: ${targetPath}`);
  }
  const content = safeReadFile(resolvedPath, { encoding: 'utf8' }) as string;
  return JSON.parse(content) as { kind?: string };
}

function printInteractionPacketFile(targetPath: string) {
  const parsed = loadPacketFile(targetPath);
  if (parsed.kind === 'operator-interaction-packet') {
    printOperatorPacket(parsed as OperatorInteractionPacket);
    return;
  }
  if (parsed.kind === 'system-status-report') {
    printSystemStatusReport(parsed as SystemStatusReportLike);
    return;
  }
  if (parsed.kind === 'operator-response-preview') {
    printResponsePreview(parsed as OperatorResponsePreview);
    return;
  }
  throw new Error(`Unsupported packet kind: ${parsed.kind || 'unknown'}`);
}

function loadPacketLike(targetPath: string): OperatorInteractionPacket | SystemStatusReportLike {
  const parsed = loadPacketFile(targetPath);
  if (parsed.kind === 'operator-interaction-packet' || parsed.kind === 'system-status-report') {
    return parsed as OperatorInteractionPacket | SystemStatusReportLike;
  }
  throw new Error(`Unsupported packet kind: ${parsed.kind || 'unknown'}`);
}

function tokenizeSuggestedCommand(command: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map(token => token.replace(/^['"]|['"]$/g, ''));
}

function acceptNextAction(packetPath: string, actionId: string) {
  const packet = loadPacketLike(packetPath);
  const nextActions = Array.isArray(packet.next_actions) ? packet.next_actions : [];
  const action = nextActions.find(item => item.id === actionId);
  if (!action) {
    throw new Error(`Next action "${actionId}" not found in packet.`);
  }
  printHeader();
  console.log(chalk.bold(`Executing next action: ${action.id}`));
  console.log(action.action);
  let output = '';
  if (action.suggested_command) {
    const [command, ...args] = tokenizeSuggestedCommand(action.suggested_command);
    if (!command) {
      throw new Error(`Next action "${actionId}" has an empty suggested_command.`);
    }
    console.log(`Command: ${action.suggested_command}\n`);
    output = safeExec(command, args, { cwd: rootDir, timeoutMs: 120000 });
  } else if (action.suggested_pipeline_path) {
    console.log(`Pipeline: ${action.suggested_pipeline_path}\n`);
    output = safeExec('node', ['dist/scripts/run_pipeline.js', '--input', action.suggested_pipeline_path], {
      cwd: rootDir,
      timeoutMs: 120000,
    });
  } else {
    throw new Error(`Next action "${actionId}" has neither suggested_command nor suggested_pipeline_path.`);
  }
  if (output) {
    process.stdout.write(output);
    if (!output.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  if (packet.kind === 'operator-interaction-packet' && packet.refresh_command && packet.refresh_packet_path) {
    console.log('\nRefreshing status packet...\n');
    const [refreshCommand, ...refreshArgs] = tokenizeSuggestedCommand(packet.refresh_command);
    if (!refreshCommand) {
      throw new Error('refresh_command is empty.');
    }
    const refreshOutput = safeExec(refreshCommand, refreshArgs, { cwd: rootDir, timeoutMs: 120000 });
    if (refreshOutput) {
      process.stdout.write(refreshOutput);
      if (!refreshOutput.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
    printInteractionPacketFile(packet.refresh_packet_path);
  }
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
  const normalizedArgs = stripLocaleArg(args);
  const [command = 'help', firstArg, ...restArgs] = normalizedArgs;

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

  if (command === 'mobile-profiles') {
    if (!firstArg) {
      printMobileAppProfilesSummary();
      return;
    }

    printMobileAppProfile(firstArg);
    return;
  }

  if (command === 'web-profiles') {
    if (!firstArg) {
      printWebAppProfilesSummary();
      return;
    }

    printWebAppProfile(firstArg);
    return;
  }

  if (command === 'artifact') {
    if (!firstArg) {
      throw new Error('Missing artifact path. Try `npm run cli -- artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.');
    }

    printArtifactInfo(firstArg);
    return;
  }

  if (command === 'open-artifact') {
    if (!firstArg) {
      throw new Error('Missing artifact path. Try `npm run cli -- open-artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.');
    }

    openArtifact(firstArg);
    return;
  }

  if (command === 'packet') {
    if (!firstArg) {
      throw new Error('Missing packet path. Try `npm run cli -- packet active/shared/tmp/orchestrator/operator-interaction-packet.json`.');
    }

    printInteractionPacketFile(firstArg);
    return;
  }

  if (command === 'accept-next-action') {
    if (!firstArg || !restArgs[0]) {
      throw new Error('Usage: npm run cli -- accept-next-action <packet-path> <action-id>');
    }

    acceptNextAction(firstArg, restArgs[0]);
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
