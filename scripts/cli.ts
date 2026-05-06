import {
  logger,
  pathResolver,
  safeExistsSync,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeReaddir,
  safeStat,
} from '@agent/core';
import { assertValidMobileAppProfileIndex, assertValidWebAppProfileIndex } from '@agent/core/app-profiles';
import { decideApprovalRequest, listApprovalRequests } from '@agent/core/governance';
import type { MobileAppProfileIndex } from '@agent/core/app-profiles';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { readJsonFile, readTextFile } from './refactor/cli-input.js';

interface RawActuatorEntry {
  n?: string;
  name?: string;
  path: string;
  d?: string;
  description?: string;
  s?: string;
  status?: string;
  contract_schema?: string;
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
  next_action_type?: 'execute_now' | 'inspect' | 'clarify' | 'start_mission' | 'resume_mission';
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

interface NextActionExecutionOutcome {
  kind: 'next-action-execution-outcome';
  action_id: string;
  action_title: string;
  source_packet_path: string;
  executed_via: 'command' | 'pipeline';
  executed_target: string;
  execution_failed: boolean;
  failure_summary?: string;
  recommended_next_action_type: 'execute_now' | 'inspect' | 'clarify' | 'start_mission' | 'resume_mission';
  deterministic_reason: string;
  llm_consult_recommended: boolean;
  llm_consult_prompt?: string;
  timestamp: string;
}

interface OperatorResponsePreview {
  kind: 'operator-response-preview';
  format: 'plain-text';
  text: string;
}

const APPROVED_PACKET_COMMAND_SCRIPTS = new Set([
  'dist/scripts/cli.js',
  'dist/scripts/mission_controller.js',
  'dist/scripts/run_pipeline.js',
]);

export interface ActuatorRecord {
  name: string;
  path: string;
  description: string;
  status: string;
  contractSchema?: string;
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
const ORCHESTRATOR_PACKET_DIR = path.join(rootDir, 'active/shared/tmp/orchestrator');
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
    return readJsonFile<VocabularyCatalog>(vocabularyPath);
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
      contractSchema: actuator.contract_schema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadActuators(): ActuatorRecord[] {
  return normalizeActuators(readJsonFile<RawActuatorIndex>(resolveIndexPath()));
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
    const state = readJsonFile<{ status?: string }>(statePath);
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
  console.log('  list [--check]       List available actuators in the global actuator index (--check: runtime capability detection)');
  console.log('  search <query>       Search actuators by name, description, or path');
  console.log('  info <name>          Show details for a specific actuator');
  console.log('  examples <name>      List actuator-owned examples for a specific actuator');
  console.log('  mobile-profiles [id] List shared mobile app profiles or inspect one profile');
  console.log('  web-profiles [id]    List shared web app profiles or inspect one profile');
  console.log('  artifact <path>      Inspect a generated artifact for review');
  console.log('  open-artifact <path> Open a generated artifact with the local viewer');
  console.log('  packet <path>        Render an operator packet, status report, or response preview');
  console.log('  accept-next-action <packet> <id>  Execute a suggested next action from a packet');
  console.log('  approvals [channel]  List pending approval requests, including secret mutations');
  console.log('  approve <id> [channel]  Approve a pending request as the current sovereign');
  console.log('  reject <id> [channel]   Reject a pending request as the current sovereign');
  console.log('  run <name> [args]    Execute an actuator, forwarding trailing arguments');
  console.log('  preview <file>       Preview a pipeline JSON and validate its steps');
  console.log('  schedule list        List all scheduled pipelines');
  console.log('  schedule register <id> <pipeline> <actuator> "<cron>"');
  console.log('                       Register a new scheduled pipeline');
  console.log('  schedule remove <id> Remove a scheduled pipeline');
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
  console.log('  npm run cli -- approvals');
  console.log('  npm run cli -- approve <request-id>');
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
  if (actuator.contractSchema) {
    console.log(`Contract schema: ${actuator.contractSchema}`);
  }
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

  const parsed = readJsonFile<ActuatorExampleCatalog>(catalogPath);
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
  const parsed = readJsonFile<MobileAppProfileIndex>(indexPath);
  assertValidMobileAppProfileIndex(parsed, indexPath, (relativePath) => safeExistsSync(path.join(rootDir, relativePath)));
  return parsed.profiles;
}

function resolveWebAppProfileIndexPath(): string {
  return pathResolver.knowledge('public/orchestration/web-app-profiles/index.json');
}

function loadWebAppProfiles(): WebAppProfileIndexRecord[] {
  const indexPath = resolveWebAppProfileIndexPath();
  if (!safeExistsSync(indexPath)) return [];
  const parsed = readJsonFile<{ profiles: WebAppProfileIndexRecord[] }>(indexPath);
  assertValidWebAppProfileIndex(parsed, indexPath, (relativePath) => safeExistsSync(path.join(rootDir, relativePath)));
  return parsed.profiles;
}

// ─── Generic profile printer (shared by mobile + web) ──────────────────────────
type AppProfileRecord = { id: string; platform: string; title: string; description: string; path: string; tags?: string[] };

function printAppProfilesSummary(profiles: AppProfileRecord[], kind: string): void {
  printHeader();
  console.log(`${kind} profiles\n`);
  if (profiles.length === 0) {
    console.log(`No shared ${kind.toLowerCase()} profiles found.`);
    return;
  }
  profiles.forEach(profile => {
    console.log(`- ${chalk.bold(profile.id)} (${profile.platform})`);
    console.log(`  ${profile.title}`);
    console.log(`  ${profile.description}`);
    console.log(`  ${chalk.gray(profile.path)}`);
    if (profile.tags?.length) console.log(`  tags: ${profile.tags.join(', ')}`);
  });
}

function printAppProfile(profiles: AppProfileRecord[], profileId: string, kind: string): void {
  const profile = profiles.find(entry => entry.id === profileId);
  if (!profile) throw new Error(`${kind} profile "${profileId}" not found.`);
  printHeader();
  console.log(`${chalk.bold(profile.id)} (${profile.platform})`);
  console.log(profile.title);
  console.log(profile.description);
  console.log(`Path: ${profile.path}`);
  if (profile.tags?.length) console.log(`Tags: ${profile.tags.join(', ')}`);
}

function printMobileAppProfilesSummary() { printAppProfilesSummary(loadMobileAppProfiles(), 'Mobile app'); }
function printMobileAppProfile(profileId: string) { printAppProfile(loadMobileAppProfiles(), profileId, 'Mobile app'); }
function printWebAppProfilesSummary() { printAppProfilesSummary(loadWebAppProfiles(), 'Web app'); }
function printWebAppProfile(profileId: string) { printAppProfile(loadWebAppProfiles(), profileId, 'Web app'); }



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
    const content = readTextFile(resolvedPath);
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
  printHeader();
  console.log(chalk.bold(packet.headline));
  console.log(packet.summary);
  if (packet.readiness) {
    console.log(`${t('cli_readiness')}: ${packet.readiness}`);
  }
  if (typeof packet.confidence === 'number') {
    console.log(`${t('cli_confidence')}: ${packet.confidence}`);
  }
  if (packet.suggested_response_style) {
    console.log(`${t('cli_response_style')}: ${packet.suggested_response_style}`);
  }
  if (packet.questions?.length) {
    console.log(`\n${t('cli_questions')}:`);
    packet.questions.forEach(question => {
      console.log(`- ${chalk.bold(question.id)}: ${question.question}`);
      console.log(`  ${t('cli_reason')}: ${question.reason}`);
      if (question.default_assumption) console.log(`  ${t('cli_default')}: ${question.default_assumption}`);
      if (question.impact) console.log(`  ${t('cli_impact')}: ${question.impact}`);
    });
  }
  if (packet.next_actions?.length) {
    console.log(`\n${t('cli_next_actions')}:`);
    packet.next_actions.forEach(action => {
      console.log(`- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}${action.next_action_type ? ` <${action.next_action_type}>` : ''}: ${action.action}`);
      if (action.reason) console.log(`  ${t('cli_reason')}: ${action.reason}`);
      if (action.suggested_command) console.log(`  ${t('cli_command')}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path) console.log(`  ${t('cli_pipeline')}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request) console.log(`  ${t('cli_follow_up')}: ${action.suggested_followup_request}`);
    });
  }
}

function printSystemStatusReport(report: SystemStatusReportLike) {
  printHeader();
  console.log(chalk.bold(report.headline));
  console.log(report.summary);
  if (report.findings?.length) {
    console.log(`\n${t('cli_findings')}:`);
    report.findings.forEach(finding => {
      console.log(`- ${chalk.bold(finding.id)} [${finding.severity}]: ${finding.message}`);
      if (finding.detail) console.log(`  ${t('cli_detail')}: ${finding.detail}`);
    });
  }
  if (report.next_actions?.length) {
    console.log(`\n${t('cli_next_actions')}:`);
    report.next_actions.forEach(action => {
      console.log(`- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}${action.next_action_type ? ` <${action.next_action_type}>` : ''}: ${action.action}`);
      if (action.reason) console.log(`  ${t('cli_reason')}: ${action.reason}`);
      if (action.suggested_command) console.log(`  ${t('cli_command')}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path) console.log(`  ${t('cli_pipeline')}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request) console.log(`  ${t('cli_follow_up')}: ${action.suggested_followup_request}`);
    });
  }
}

function printResponsePreview(preview: OperatorResponsePreview) {
  printHeader();
  console.log(preview.text);
}

function loadPacketFile(targetPath: string): { kind?: string } {
  const resolvedPath = path.resolve(rootDir, targetPath);
  assertPacketPathAllowed(resolvedPath);
  if (!safeExistsSync(resolvedPath)) {
    throw new Error(`Packet file not found: ${targetPath}`);
  }
  const content = readTextFile(resolvedPath);
  return JSON.parse(content) as { kind?: string };
}

function isPathWithin(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertPacketPathAllowed(resolvedPath: string): void {
  if (resolvedPath === ORCHESTRATOR_PACKET_DIR || isPathWithin(ORCHESTRATOR_PACKET_DIR, resolvedPath)) {
    return;
  }
  throw new Error(`Packet path must stay within ${path.relative(rootDir, ORCHESTRATOR_PACKET_DIR)}.`);
}

export function assertApprovedNextActionCommand(command: string): void {
  const [bin, ...args] = tokenizeSuggestedCommand(command);
  if (bin !== 'node') {
    throw new Error(`Only node-based packet commands are allowed. Received: ${bin || 'empty'}`);
  }
  const script = args[0];
  if (!script || script.startsWith('-')) {
    throw new Error('Packet commands must target an approved dist/scripts entrypoint.');
  }
  if (!APPROVED_PACKET_COMMAND_SCRIPTS.has(script)) {
    throw new Error(`Packet command script is not approved: ${script}`);
  }
}

export function assertApprovedPipelinePath(pipelinePath: string): void {
  const resolvedPath = path.resolve(rootDir, pipelinePath);
  const allowed = (
    isPathWithin(path.join(rootDir, 'pipelines'), resolvedPath) ||
    isPathWithin(ORCHESTRATOR_PACKET_DIR, resolvedPath)
  );
  if (!allowed || path.extname(resolvedPath) !== '.json') {
    throw new Error(`Pipeline path is not approved: ${pipelinePath}`);
  }
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

export function classifyNextActionExecutionOutcome(
  packetPath: string,
  action: OperatorPacketAction,
  executedVia: 'command' | 'pipeline',
  executedTarget: string,
  executionFailed: boolean,
  failureSummary: string | undefined,
  output: string,
): NextActionExecutionOutcome {
  const normalizedOutput = String(output || '').toLowerCase();
  const explicitType = action.next_action_type;

  let recommended: NextActionExecutionOutcome['recommended_next_action_type'] = explicitType || 'inspect';
  let deterministicReason = explicitType
    ? `The action declared next_action_type=${explicitType}.`
    : 'No explicit next_action_type was provided, so inspection is the safe default.';

  if (!explicitType) {
    if (normalizedOutput.includes('missing input') || normalizedOutput.includes('clarification')) {
      recommended = 'clarify';
      deterministicReason = 'The execution output suggests that additional clarification is still required.';
    } else if (normalizedOutput.includes('mission_controller.js resume') || normalizedOutput.includes('resum')) {
      recommended = 'resume_mission';
      deterministicReason = 'The execution path or output indicates a mission resume action.';
    } else if (normalizedOutput.includes('mission_controller.js start') || normalizedOutput.includes('activate')) {
      recommended = 'start_mission';
      deterministicReason = 'The execution path or output indicates mission creation or activation.';
    } else if (executedVia === 'pipeline') {
      recommended = 'inspect';
      deterministicReason = 'Pipeline execution completed; the next safe step is to inspect outputs and evidence.';
    } else if (action.suggested_command) {
      recommended = 'inspect';
      deterministicReason = 'Command execution completed; the next safe step is to inspect resulting state or artifacts.';
    }
  }

  const llmConsultRecommended = (
    recommended === 'clarify' ||
    normalizedOutput.includes('error') ||
    normalizedOutput.includes('failed') ||
    normalizedOutput.includes('warning')
  );

  return {
    kind: 'next-action-execution-outcome',
    action_id: action.id,
    action_title: action.action,
    source_packet_path: packetPath,
    executed_via: executedVia,
    executed_target: executedTarget,
    execution_failed: executionFailed,
    ...(failureSummary ? { failure_summary: failureSummary } : {}),
    recommended_next_action_type: recommended,
    deterministic_reason: deterministicReason,
    llm_consult_recommended: llmConsultRecommended,
    ...(llmConsultRecommended ? {
      llm_consult_prompt: `Classify the outcome of next action "${action.id}" and propose the safest follow-up. Deterministic classification suggested "${recommended}". Output observed: ${output.slice(0, 1200)}`,
    } : {}),
    timestamp: new Date().toISOString(),
  };
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
  let executedVia: 'command' | 'pipeline';
  let executedTarget = '';
  let executionFailed = false;
  let failureSummary: string | undefined;
  try {
    if (action.suggested_command) {
      assertApprovedNextActionCommand(action.suggested_command);
      const [command, ...args] = tokenizeSuggestedCommand(action.suggested_command);
      if (!command) {
        throw new Error(`Next action "${actionId}" has an empty suggested_command.`);
      }
      console.log(`Command: ${action.suggested_command}\n`);
      output = safeExec(command, args, { cwd: rootDir, timeoutMs: 120000 });
      executedVia = 'command';
      executedTarget = action.suggested_command;
    } else if (action.suggested_pipeline_path) {
      assertApprovedPipelinePath(action.suggested_pipeline_path);
      console.log(`Pipeline: ${action.suggested_pipeline_path}\n`);
      output = safeExec('node', ['dist/scripts/run_pipeline.js', '--input', action.suggested_pipeline_path], {
        cwd: rootDir,
        timeoutMs: 120000,
      });
      executedVia = 'pipeline';
      executedTarget = action.suggested_pipeline_path;
    } else {
      throw new Error(`Next action "${actionId}" has neither suggested_command nor suggested_pipeline_path.`);
    }
  } catch (error: any) {
    executionFailed = true;
    failureSummary = error?.message || String(error);
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    output = [stdout, stderr, failureSummary].filter(Boolean).join('\n');
    if (!executedTarget) {
      if (action.suggested_command) {
        executedVia = 'command';
        executedTarget = action.suggested_command;
      } else if (action.suggested_pipeline_path) {
        executedVia = 'pipeline';
        executedTarget = action.suggested_pipeline_path;
      } else {
        throw error;
      }
    }
  }
  if (output) {
    process.stdout.write(output);
    if (!output.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  const outcome = classifyNextActionExecutionOutcome(packetPath, action, executedVia, executedTarget, executionFailed, failureSummary, output);
  const outcomePath = path.join(rootDir, 'active/shared/tmp/orchestrator', `next-action-outcome-${action.id}.json`);
  safeWriteFile(outcomePath, JSON.stringify(outcome, null, 2));
  console.log(`\nOutcome classification: ${outcome.recommended_next_action_type}`);
  console.log(`Reason: ${outcome.deterministic_reason}`);
  console.log(`LLM consult recommended: ${outcome.llm_consult_recommended ? 'yes' : 'no'}`);
  console.log(`Outcome artifact: ${outcomePath}`);
  if (packet.kind === 'operator-interaction-packet' && packet.refresh_command && packet.refresh_packet_path) {
    console.log('\nRefreshing status packet...\n');
    assertApprovedNextActionCommand(packet.refresh_command);
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

function printApprovalRequests(channelArg?: string) {
  printHeader();
  const storageChannels = channelArg ? [channelArg] : undefined;
  const requests = listApprovalRequests({
    storageChannels,
    status: 'pending',
  });

  if (requests.length === 0) {
    console.log('No pending approval requests found.');
    return;
  }

  console.log(`Pending approvals: ${requests.length}\n`);
  for (const request of requests) {
    console.log(`- ${chalk.bold(request.id)} [${request.kind}]`);
    console.log(`  ${request.title}`);
    console.log(`  status: ${request.status} · channel: ${request.storageChannel} · requested by: ${request.requestedBy}`);
    if (request.target) {
      console.log(`  target: ${request.target.serviceId}/${request.target.secretKey} (${request.target.mutation})`);
    }
    if (request.risk) {
      console.log(`  risk: ${request.risk.level} · restart: ${request.risk.restartScope} · strong auth: ${request.risk.requiresStrongAuth ? 'yes' : 'no'}`);
    }
    if (request.justification?.reason) {
      console.log(`  reason: ${request.justification.reason}`);
    }
    if (request.workflow) {
      const pendingRoles = request.workflow.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.role);
      console.log(`  workflow: ${request.workflow.workflowId} · pending roles: ${pendingRoles.join(', ') || 'none'}`);
    }
  }
}

function applyApprovalDecision(command: 'approve' | 'reject', requestId: string | undefined, channelArg?: string) {
  if (!requestId) {
    throw new Error(`Usage: npm run cli -- ${command} <request-id> [storage-channel]`);
  }

  const requests = listApprovalRequests({
    storageChannels: channelArg ? [channelArg] : undefined,
    status: 'pending',
  });
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) {
    throw new Error(`Pending approval request "${requestId}" not found.`);
  }

  const decision = command === 'approve' ? 'approved' : 'rejected';
  const decided = decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision,
    decidedBy: 'sovereign-user',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    note: `decision submitted from terminal via npm run cli -- ${command}`,
  });

  printHeader();
  console.log(`${chalk.bold(decided.id)} ${decision}`);
  console.log(`${decided.title}`);
  console.log(`storage channel: ${decided.storageChannel}`);
  if (decided.target) {
    console.log(`target: ${decided.target.serviceId}/${decided.target.secretKey} (${decided.target.mutation})`);
  }
  if (decided.workflow) {
    const completedRoles = decided.workflow.approvals
      .filter((approval) => approval.status === decision)
      .map((approval) => approval.role);
    console.log(`workflow roles updated: ${completedRoles.join(', ') || 'none'}`);
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
      timeoutMs: 1800000, // 30 minutes for long-running actuators (media generation, etc.)
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
    const hasCheck = normalizedArgs.includes('--check');
    if (hasCheck) {
      const { checkAllActuatorCapabilities } = await import('@agent/core');
      const statuses = await checkAllActuatorCapabilities();
      console.log('\n=== Runtime Capability Check ===');
      for (const status of statuses) {
        const available = status.capabilities.filter(c => c.available).length;
        const total = status.capabilities.length;
        const icon = available === total ? '\u2705' : available > 0 ? '\u26A0\uFE0F' : '\u274C';
        console.log(`${icon} ${status.actuatorId} (v${status.version}): ${available}/${total} ops available`);
        for (const cap of status.capabilities) {
          if (!cap.available) {
            console.log(`   \u274C ${cap.op}: ${cap.reason}`);
            if (cap.prerequisites) console.log(`      Fix: ${cap.prerequisites.join(', ')}`);
          }
        }
      }
    }
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

  if (command === 'approvals') {
    printApprovalRequests(firstArg);
    return;
  }

  if (command === 'approve' || command === 'reject') {
    applyApprovalDecision(command, firstArg, restArgs[0]);
    return;
  }

  if (command === 'run') {
    runActuator(actuators, firstArg, restArgs, missionId);
    return;
  }

  if (command === 'preview') {
    const { previewPipeline } = await import('@agent/core');
    const filePath = firstArg;
    if (!filePath) { console.error('Usage: pnpm cli preview <pipeline.json>'); process.exit(1); }
    const content = readTextFile(pathResolver.rootResolve(filePath));
    const pipeline = JSON.parse(content);
    const preview = previewPipeline(pipeline);

    console.log(`\n=== Pipeline Preview ===`);
    console.log(`Valid: ${preview.valid ? '\u2705' : '\u274C'}`);
    console.log(`Total steps: ${preview.totalSteps}`);
    if (preview.errors.length > 0) {
      console.log(`\nErrors:`);
      preview.errors.forEach((e: string) => console.log(`  \u274C ${e}`));
    }
    if (preview.warnings.length > 0) {
      console.log(`\nWarnings:`);
      preview.warnings.forEach((w: string) => console.log(`  \u26A0\uFE0F  ${w}`));
    }
    console.log(`\nSteps:`);
    const printStep = (step: any, indent: number = 0) => {
      const pad = '  '.repeat(indent);
      const warn = step.warnings?.length ? ` \u26A0\uFE0F ${step.warnings.length}` : '';
      console.log(`${pad}${step.index + 1}. [${step.type}:${step.op}] ${step.description}${warn}`);
      if (step.children) step.children.forEach((c: any) => printStep(c, indent + 1));
    };
    preview.steps.forEach((s: any) => printStep(s));
    process.exit(preview.valid ? 0 : 1);
  }

  if (command === 'schedule') {
    const subAction = firstArg; // register, list, remove
    const { registerScheduledPipeline, unregisterScheduledPipeline, listScheduledPipelines } = await import('@agent/core');

    if (subAction === 'list') {
      const schedules = listScheduledPipelines();
      if (schedules.length === 0) { console.log('No scheduled pipelines.'); }
      else {
        console.log(`\n=== Scheduled Pipelines (${schedules.length}) ===`);
        for (const s of schedules) {
          const status = s.enabled ? '\u2705' : '\u23F8\uFE0F';
          const trigger = s.trigger.type === 'cron' ? `cron: ${s.trigger.cron}` : `interval: ${s.trigger.intervalMs}ms`;
          const last = s.lastRun ? ` | last: ${s.lastRun} (${s.lastStatus})` : '';
          console.log(`${status} ${s.id} \u2014 ${s.name} [${s.actuator}] ${trigger}${last}`);
          console.log(`   pipeline: ${s.pipelinePath}`);
        }
      }
    } else if (subAction === 'register') {
      // pnpm cli schedule register <id> <pipeline-path> <actuator> <cron>
      const [id, pipelinePath, actuator, cron] = restArgs;
      if (!id || !pipelinePath || !actuator || !cron) {
        console.error('Usage: pnpm cli schedule register <id> <pipeline-path> <actuator> "<cron>"');
        process.exit(1);
      }
      registerScheduledPipeline({
        id, name: id, pipelinePath, actuator,
        trigger: { type: 'cron', cron },
        enabled: true,
      });
      console.log(`Registered: ${id} \u2192 ${pipelinePath} [${actuator}] cron: ${cron}`);
    } else if (subAction === 'remove') {
      const id = restArgs[0];
      if (!id) { console.error('Usage: pnpm cli schedule remove <id>'); process.exit(1); }
      unregisterScheduledPipeline(id);
      console.log(`Removed: ${id}`);
    } else {
      console.log('Usage: pnpm cli schedule [list|register|remove]');
    }
    process.exit(0);
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
