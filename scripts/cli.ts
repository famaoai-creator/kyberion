#!/usr/bin/env node
import { pathResolver } from '@agent/core/path-resolver';
import { resolveOperatorDisplayName } from '@agent/core/operator-identity';
import { resolveLocale as resolveUnifiedLocale, type SupportedLocale } from '@agent/core/locale';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeWriteFile,
  safeReaddir,
  safeStat,
  safeLstat,
} from '@agent/core/secure-io';
import { loadActuatorManifestCatalog } from '@agent/core/src/actuator-manifest-index';
import { installReasoningBackends } from '@agent/core/reasoning-bootstrap';
import { renderStatus } from '@agent/core/ux-vocabulary';
import { checkAllActuatorCapabilities } from '@agent/core/src/actuator-capability';
import {
  assertPipelinePreviewResourcePath,
  previewPipeline,
} from '@agent/core/src/pipeline-preview';
import {
  listScheduledPipelines,
  registerScheduledPipeline,
  unregisterScheduledPipeline,
} from '@agent/core/pipeline-scheduler';
import { t as coreT } from '@agent/core/t';
import type { VocabularyKey } from '@agent/core/t';
import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import {
  assertValidMobileAppProfileIndex,
  assertValidWebAppProfileIndex,
} from '@agent/core/app-profiles';
import { decideApprovalRequest, listApprovalRequests } from '@agent/core/governance';
import { createProjectTrustApprovalRequest } from '@agent/core/project-trust';
import type { MobileAppProfileIndex } from '@agent/core/app-profiles';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { parseSafeJsonInput, readJson, readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  handleCalendarWorkflowCommand,
  handleEmailWorkflowCommand,
  handleOffboardCommand,
  handleTaskCommand,
} from './cli-workflow-handlers.js';
export { parseOffboardArgs } from './cli-workflow-handlers.js';
import { printBranchBanner, printHeader, printHelp } from './cli-presentation.js';
import { parseInteractionPacket } from './cli-packet-parser.js';
export { parseInteractionPacket } from './cli-packet-parser.js';
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
  missing_inputs?: string[];
  omitted_question_count?: number;
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
  recommended_next_action_type:
    'execute_now' | 'inspect' | 'clarify' | 'start_mission' | 'resume_mission';
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

type PacketFile = OperatorInteractionPacket | SystemStatusReportLike | OperatorResponsePreview;

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
let activeCliArgs: string[] = [];

/**
 * @deprecated Thin wrapper over `@agent/core`'s `resolveLocale`. `--locale`
 * takes the `explicit` slot of the unified precedence chain; when absent,
 * resolution now falls through identity → `KYBERION_LOCALE` →
 * `KYBERION_UI_LOCALE` (deprecated) → `LANG` → catalog default, instead of
 * the old CLI-only chain (`--locale` → `KYBERION_UI_LOCALE` → `LANG` →
 * `'en'`). This is the I18N-01 unification: every locale resolver now
 * agrees on the same result for the same environment.
 */
function resolveLocale(args: string[] = activeCliArgs): SupportedLocale {
  const localeArgIndex = args.indexOf('--locale');
  const localeArg = localeArgIndex >= 0 ? args[localeArgIndex + 1] : undefined;
  return resolveUnifiedLocale({ explicit: localeArg });
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

export function stripNpmSeparatorArg(args: string[]): string[] {
  return args.filter((arg) => arg !== '--');
}

/**
 * I18N-02: thin wrapper delegating to `@agent/core`'s type-safe `t()`. Kept
 * as a local `(key, locale)` shim rather than calling `coreT` directly at
 * every one of this file's ~90 call sites, since those all pass a bare
 * (unqualified) key with no `params` argument.
 */
function t(key: VocabularyKey, locale = resolveLocale()): string {
  return coreT(key, undefined, locale);
}

export function normalizeActuators(index: {
  s?: RawActuatorEntry[];
  actuators?: RawActuatorEntry[];
  skills?: RawActuatorEntry[];
}): ActuatorRecord[] {
  const rawActuators = index.actuators || index.s || index.skills || [];

  return rawActuators
    .map((actuator) => ({
      name: actuator.n || actuator.name || path.basename(actuator.path),
      path: actuator.path,
      description: actuator.d || actuator.description || 'No description available.',
      status: actuator.s || actuator.status || 'unknown',
      contractSchema: actuator.contract_schema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadActuators(): ActuatorRecord[] {
  return loadActuatorManifestCatalog().map((entry) => ({
    name: entry.n,
    path: entry.path,
    description: entry.d,
    status: entry.s,
    contractSchema: entry.contract_schema,
  }));
}

export function searchActuators(actuators: ActuatorRecord[], query: string): ActuatorRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return actuators;
  }

  return actuators.filter(
    (actuator) =>
      actuator.name.toLowerCase().includes(normalizedQuery) ||
      actuator.description.toLowerCase().includes(normalizedQuery) ||
      actuator.path.toLowerCase().includes(normalizedQuery)
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

export function resolveMissionStatePathForBanner(missionId: string): string {
  const missionPath =
    pathResolver.findMissionPath(missionId) || pathResolver.missionDir(missionId, 'public');
  return assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'));
}

function printMissionContextBanner(missionId?: string) {
  if (!missionId) {
    return;
  }

  let statePath: string;
  try {
    statePath = resolveMissionStatePathForBanner(missionId);
  } catch {
    return;
  }
  if (!safeExistsSync(statePath)) {
    return;
  }

  try {
    const state = readJson<{ status?: string }>(statePath);
    process.stderr.write(
      chalk.cyan(
        `\n🧠 BRAIN: Context hydrated from mission "${missionId}" (Status: ${state.status || 'unknown'})\n`
      )
    );
  } catch {
    // Keep the console usable even if mission metadata is malformed.
  }
}

/**
 * SX-08 compatibility route: the legacy intent command now uses the
 * operator's canonical surface entrypoint for both inspection and execution.
 * The old --run flag remains accepted by the argument parser as a
 * compatibility alias; ask already owns the governed execution decision.
 */
export async function routeLegacyIntentToAsk(
  utterance: string,
  mode: 'explain' | 'clarify' = 'explain'
): Promise<void> {
  const askFlag = mode === 'clarify' ? '--clarify' : '--explain';
  console.error(
    `[DEPRECATED] \`pnpm kyberion intent\` is now routed to \`pnpm kyberion ask ${askFlag}\`; use the latter directly.`
  );
  const { main: operatorHomeMain } = await import('./kyberion_home.js');
  await operatorHomeMain(['ask', utterance, askFlag]);
}

function printActuatorList(actuators: ActuatorRecord[]) {
  printHeader();

  if (actuators.length === 0) {
    console.log('No actuators were found in the actuator catalog.');
    return;
  }

  console.log(`Indexed actuators: ${actuators.length}\n`);
  actuators.forEach((actuator) => {
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
    console.log(`  ${examples.map((example) => example.id).join(', ')}`);
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
  return assertSafeRepositoryPath(path.join(rootDir, actuator.path, 'examples', 'catalog.json'), {
    allowMissingLeaf: true,
  });
}

export function resolveAppProfileResourcePath(relativePath: string): string {
  const resolved = assertSafeRepositoryPath(
    pathResolver.rootResolve(String(relativePath || '').trim()),
    {
      allowMissingLeaf: false,
    }
  );
  if (!safeLstat(resolved).isFile()) {
    throw new Error(
      `[APP_PROFILE_RESOURCE_INVALID] resource must be a regular file: ${relativePath}`
    );
  }
  return resolved;
}

function loadActuatorExamples(actuator: ActuatorRecord): ActuatorExampleRecord[] {
  const catalogPath = resolveActuatorExamplesCatalogPath(actuator);
  if (!safeExistsSync(catalogPath) || !safeLstat(catalogPath).isFile()) {
    return [];
  }

  const parsed = readJson<ActuatorExampleCatalog>(catalogPath);
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

  examples.forEach((example) => {
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
  return pathResolver.knowledge('product/orchestration/mobile-app-profiles/index.json');
}

function loadMobileAppProfiles(): MobileAppProfileRecord[] {
  const indexPath = resolveMobileAppProfileIndexPath();
  if (!safeExistsSync(indexPath) || !safeLstat(indexPath).isFile()) {
    return [];
  }
  const parsed = readJson<MobileAppProfileIndex>(indexPath);
  assertValidMobileAppProfileIndex(parsed, indexPath, (relativePath) =>
    safeExistsSync(resolveAppProfileResourcePath(relativePath))
  );
  return parsed.profiles;
}

function resolveWebAppProfileIndexPath(): string {
  return pathResolver.knowledge('product/orchestration/web-app-profiles/index.json');
}

function loadWebAppProfiles(): WebAppProfileIndexRecord[] {
  const indexPath = resolveWebAppProfileIndexPath();
  if (!safeExistsSync(indexPath) || !safeLstat(indexPath).isFile()) return [];
  const parsed = readJson<{ profiles: WebAppProfileIndexRecord[] }>(indexPath);
  assertValidWebAppProfileIndex(parsed, indexPath, (relativePath) =>
    safeExistsSync(resolveAppProfileResourcePath(relativePath))
  );
  return parsed.profiles;
}

// ─── Generic profile printer (shared by mobile + web) ──────────────────────────
type AppProfileRecord = {
  id: string;
  platform: string;
  title: string;
  description: string;
  path: string;
  tags?: string[];
};

function printAppProfilesSummary(profiles: AppProfileRecord[], kind: string): void {
  printHeader();
  console.log(`${kind} profiles\n`);
  if (profiles.length === 0) {
    console.log(`No shared ${kind.toLowerCase()} profiles found.`);
    return;
  }
  profiles.forEach((profile) => {
    console.log(`- ${chalk.bold(profile.id)} (${profile.platform})`);
    console.log(`  ${profile.title}`);
    console.log(`  ${profile.description}`);
    console.log(`  ${chalk.gray(profile.path)}`);
    if (profile.tags?.length) console.log(`  tags: ${profile.tags.join(', ')}`);
  });
}

function printAppProfile(profiles: AppProfileRecord[], profileId: string, kind: string): void {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`${kind} profile "${profileId}" not found.`);
  printHeader();
  console.log(`${chalk.bold(profile.id)} (${profile.platform})`);
  console.log(profile.title);
  console.log(profile.description);
  console.log(`Path: ${profile.path}`);
  if (profile.tags?.length) console.log(`Tags: ${profile.tags.join(', ')}`);
}

function printMobileAppProfilesSummary() {
  printAppProfilesSummary(loadMobileAppProfiles(), 'Mobile app');
}
function printMobileAppProfile(profileId: string) {
  printAppProfile(loadMobileAppProfiles(), profileId, 'Mobile app');
}
function printWebAppProfilesSummary() {
  printAppProfilesSummary(loadWebAppProfiles(), 'Web app');
}
function printWebAppProfile(profileId: string) {
  printAppProfile(loadWebAppProfiles(), profileId, 'Web app');
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

export function formatOperatorPacketLines(packet: OperatorInteractionPacket): string[] {
  const locale = resolveLocale();
  const lines = [chalk.bold(packet.headline), packet.summary];
  if (packet.readiness) {
    lines.push(
      `${t('cli_readiness', locale)}: ${renderStatus('readiness', packet.readiness, locale)}`
    );
  }
  if (typeof packet.confidence === 'number') {
    lines.push(`${t('cli_confidence', locale)}: ${packet.confidence}`);
  }
  if (packet.missing_inputs?.length) {
    lines.push(`${t('cli_missing_inputs', locale)}: ${packet.missing_inputs.join(', ')}`);
  }
  if (typeof packet.omitted_question_count === 'number' && packet.omitted_question_count > 0) {
    lines.push(
      t('cli_more_questions', locale).replace('{count}', String(packet.omitted_question_count))
    );
  }
  if (packet.suggested_response_style) {
    lines.push(`${t('cli_response_style', locale)}: ${packet.suggested_response_style}`);
  }
  if (packet.questions?.length) {
    lines.push('', `${t('cli_questions', locale)}:`);
    packet.questions.forEach((question) => {
      lines.push(`- ${chalk.bold(question.id)}: ${question.question}`);
      lines.push(`  ${t('cli_reason', locale)}: ${question.reason}`);
      if (question.default_assumption)
        lines.push(`  ${t('cli_default', locale)}: ${question.default_assumption}`);
      if (question.impact) lines.push(`  ${t('cli_impact', locale)}: ${question.impact}`);
    });
  }
  if (packet.next_actions?.length) {
    lines.push('', `${t('cli_next_actions', locale)}:`);
    packet.next_actions.forEach((action) => {
      lines.push(
        `- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}${action.next_action_type ? ` <${action.next_action_type}>` : ''}: ${action.action}`
      );
      if (action.reason) lines.push(`  ${t('cli_reason', locale)}: ${action.reason}`);
      if (action.suggested_command)
        lines.push(`  ${t('cli_command', locale)}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path)
        lines.push(`  ${t('cli_pipeline', locale)}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request)
        lines.push(`  ${t('cli_follow_up', locale)}: ${action.suggested_followup_request}`);
    });
  }
  return lines;
}

function printOperatorPacket(packet: OperatorInteractionPacket) {
  printHeader();
  for (const line of formatOperatorPacketLines(packet)) {
    console.log(line);
  }
}

function printSystemStatusReport(report: SystemStatusReportLike) {
  printHeader();
  console.log(chalk.bold(report.headline));
  console.log(report.summary);
  if (report.findings?.length) {
    console.log(`\n${t('cli_findings')}:`);
    report.findings.forEach((finding) => {
      console.log(`- ${chalk.bold(finding.id)} [${finding.severity}]: ${finding.message}`);
      if (finding.detail) console.log(`  ${t('cli_detail')}: ${finding.detail}`);
    });
  }
  if (report.next_actions?.length) {
    console.log(`\n${t('cli_next_actions')}:`);
    report.next_actions.forEach((action) => {
      console.log(
        `- ${chalk.bold(action.id)}${action.priority ? ` [${action.priority}]` : ''}${action.next_action_type ? ` <${action.next_action_type}>` : ''}: ${action.action}`
      );
      if (action.reason) console.log(`  ${t('cli_reason')}: ${action.reason}`);
      if (action.suggested_command)
        console.log(`  ${t('cli_command')}: ${action.suggested_command}`);
      if (action.suggested_pipeline_path)
        console.log(`  ${t('cli_pipeline')}: ${action.suggested_pipeline_path}`);
      if (action.suggested_followup_request)
        console.log(`  ${t('cli_follow_up')}: ${action.suggested_followup_request}`);
    });
  }
}

function printResponsePreview(preview: OperatorResponsePreview) {
  printHeader();
  console.log(preview.text);
}

function loadPacketFile(targetPath: string): PacketFile {
  const resolvedPath = path.resolve(rootDir, targetPath);
  assertPacketPathAllowed(resolvedPath);
  if (!safeExistsSync(resolvedPath)) {
    throw new Error(`Packet file not found: ${targetPath}`);
  }
  const content = readTextFile(resolvedPath);
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(content, 'Packet file');
  } catch (error) {
    throw new Error(
      `Packet file contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const packet = parseInteractionPacket(parsed);
  if (!packet) throw new Error(`Packet file contains an invalid packet shape: ${targetPath}`);
  return packet;
}

function isPathWithin(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertPacketPathAllowed(resolvedPath: string): void {
  if (
    resolvedPath === ORCHESTRATOR_PACKET_DIR ||
    isPathWithin(ORCHESTRATOR_PACKET_DIR, resolvedPath)
  ) {
    return;
  }
  throw new Error(
    `Packet path must stay within ${path.relative(rootDir, ORCHESTRATOR_PACKET_DIR)}.`
  );
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
  const allowed =
    isPathWithin(path.join(rootDir, 'pipelines'), resolvedPath) ||
    isPathWithin(ORCHESTRATOR_PACKET_DIR, resolvedPath);
  if (!allowed || path.extname(resolvedPath) !== '.json') {
    throw new Error(`Pipeline path is not approved: ${pipelinePath}`);
  }
}

function printInteractionPacketFile(targetPath: string) {
  const parsed = loadPacketFile(targetPath);
  if (parsed.kind === 'operator-interaction-packet') {
    printOperatorPacket(parsed);
    return;
  }
  if (parsed.kind === 'system-status-report') {
    printSystemStatusReport(parsed);
    return;
  }
  if (parsed.kind === 'operator-response-preview') {
    printResponsePreview(parsed);
    return;
  }
}

function loadPacketLike(targetPath: string): OperatorInteractionPacket | SystemStatusReportLike {
  const parsed = loadPacketFile(targetPath);
  if (parsed.kind === 'operator-interaction-packet' || parsed.kind === 'system-status-report') {
    return parsed;
  }
  throw new Error(`Unsupported packet kind: ${parsed.kind || 'unknown'}`);
}

function tokenizeSuggestedCommand(command: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

export function classifyNextActionExecutionOutcome(
  packetPath: string,
  action: OperatorPacketAction,
  executedVia: 'command' | 'pipeline',
  executedTarget: string,
  executionFailed: boolean,
  failureSummary: string | undefined,
  output: string
): NextActionExecutionOutcome {
  const normalizedOutput = String(output || '').toLowerCase();
  const explicitType = action.next_action_type;

  let recommended: NextActionExecutionOutcome['recommended_next_action_type'] =
    explicitType || 'inspect';
  let deterministicReason = explicitType
    ? `The action declared next_action_type=${explicitType}.`
    : 'No explicit next_action_type was provided, so inspection is the safe default.';

  if (!explicitType) {
    if (normalizedOutput.includes('missing input') || normalizedOutput.includes('clarification')) {
      recommended = 'clarify';
      deterministicReason =
        'The execution output suggests that additional clarification is still required.';
    } else if (
      normalizedOutput.includes('mission_controller.js resume') ||
      normalizedOutput.includes('resum')
    ) {
      recommended = 'resume_mission';
      deterministicReason = 'The execution path or output indicates a mission resume action.';
    } else if (
      normalizedOutput.includes('mission_controller.js start') ||
      normalizedOutput.includes('activate')
    ) {
      recommended = 'start_mission';
      deterministicReason =
        'The execution path or output indicates mission creation or activation.';
    } else if (executedVia === 'pipeline') {
      recommended = 'inspect';
      deterministicReason =
        'Pipeline execution completed; the next safe step is to inspect outputs and evidence.';
    } else if (action.suggested_command) {
      recommended = 'inspect';
      deterministicReason =
        'Command execution completed; the next safe step is to inspect resulting state or artifacts.';
    }
  }

  const llmConsultRecommended =
    recommended === 'clarify' ||
    normalizedOutput.includes('error') ||
    normalizedOutput.includes('failed') ||
    normalizedOutput.includes('warning');

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
    ...(llmConsultRecommended
      ? {
          llm_consult_prompt: `Classify the outcome of next action "${action.id}" and propose the safest follow-up. Deterministic classification suggested "${recommended}". Output observed: ${output.slice(0, 1200)}`,
        }
      : {}),
    timestamp: new Date().toISOString(),
  };
}

function acceptNextAction(packetPath: string, actionId: string) {
  const packet = loadPacketLike(packetPath);
  const nextActions = Array.isArray(packet.next_actions) ? packet.next_actions : [];
  const action = nextActions.find((item) => item.id === actionId);
  if (!action) {
    throw new Error(`Next action "${actionId}" not found in packet.`);
  }
  printHeader();
  console.log(chalk.bold(`Executing next action: ${action.id}`));
  console.log(action.action);
  let output = '';
  let executedVia: 'command' | 'pipeline' = 'command';
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
      output = safeExec(
        'node',
        ['dist/scripts/run_pipeline.js', '--input', action.suggested_pipeline_path],
        {
          cwd: rootDir,
          timeoutMs: 120000,
        }
      );
      executedVia = 'pipeline';
      executedTarget = action.suggested_pipeline_path;
    } else {
      throw new Error(
        `Next action "${actionId}" has neither suggested_command nor suggested_pipeline_path. The packet may be malformed or was generated by an outdated pipeline. Re-run the originating pipeline or ask the orchestrator to regenerate the packet.`
      );
    }
  } catch (error: unknown) {
    executionFailed = true;
    const err = error as { message?: string; stdout?: string; stderr?: string };
    failureSummary = err?.message || String(error);
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
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
  const outcome = classifyNextActionExecutionOutcome(
    packetPath,
    action,
    executedVia,
    executedTarget,
    executionFailed,
    failureSummary,
    output
  );
  const outcomePath = path.join(
    rootDir,
    'active/shared/tmp/orchestrator',
    `next-action-outcome-${action.id}.json`
  );
  safeWriteFile(outcomePath, JSON.stringify(outcome, null, 2));
  console.log(`\nOutcome classification: ${outcome.recommended_next_action_type}`);
  console.log(`Reason: ${outcome.deterministic_reason}`);
  console.log(`LLM consult recommended: ${outcome.llm_consult_recommended ? 'yes' : 'no'}`);
  console.log(`Outcome artifact: ${outcomePath}`);
  if (
    packet.kind === 'operator-interaction-packet' &&
    packet.refresh_command &&
    packet.refresh_packet_path
  ) {
    console.log('\nRefreshing status packet...\n');
    assertApprovedNextActionCommand(packet.refresh_command);
    const [refreshCommand, ...refreshArgs] = tokenizeSuggestedCommand(packet.refresh_command);
    if (!refreshCommand) {
      throw new Error('refresh_command is empty.');
    }
    const refreshOutput = safeExec(refreshCommand, refreshArgs, {
      cwd: rootDir,
      timeoutMs: 120000,
    });
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
    console.log(
      `  status: ${request.status} · channel: ${request.storageChannel} · requested by: ${request.requestedBy}`
    );
    if (request.target) {
      console.log(
        `  target: ${request.target.serviceId}/${request.target.secretKey} (${request.target.mutation})`
      );
    }
    if (request.risk) {
      console.log(
        `  risk: ${request.risk.level} · restart: ${request.risk.restartScope} · strong auth: ${request.risk.requiresStrongAuth ? 'yes' : 'no'}`
      );
    }
    if (request.justification?.reason) {
      console.log(`  reason: ${request.justification.reason}`);
    }
    if (request.workflow) {
      const pendingRoles = request.workflow.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.role);
      console.log(
        `  workflow: ${request.workflow.workflowId} · pending roles: ${pendingRoles.join(', ') || 'none'}`
      );
    }
  }
}

function applyApprovalDecision(
  command: 'approve' | 'reject',
  requestId: string | undefined,
  channelArg?: string
) {
  if (!requestId) {
    throw new Error(
      `Usage: pnpm kyberion ${command} <request-id> [storage-channel]\nRun \`pnpm kyberion approvals\` first to list pending request IDs.`
    );
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
    decidedBy: resolveOperatorDisplayName(),
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
    note: `decision submitted from terminal via pnpm kyberion ${command}`,
  });

  printHeader();
  console.log(`${chalk.bold(decided.id)} ${decision}`);
  console.log(`${decided.title}`);
  console.log(`storage channel: ${decided.storageChannel}`);
  if (decided.target) {
    console.log(
      `target: ${decided.target.serviceId}/${decided.target.secretKey} (${decided.target.mutation})`
    );
  }
  if (decided.workflow) {
    const completedRoles = decided.workflow.approvals
      .filter((approval) => approval.status === decision)
      .map((approval) => approval.role);
    console.log(`workflow roles updated: ${completedRoles.join(', ') || 'none'}`);
  }
}

function requestProjectTrust(inputPath: string, json = false): void {
  const record = createProjectTrustApprovalRequest({
    inputPath,
    requestedBy: resolveOperatorDisplayName(),
  });
  if (json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  printHeader();
  console.log(`${chalk.bold(record.id)} pending`);
  console.log(record.title);
  console.log(`storage channel: ${record.storageChannel}`);
  console.log(
    `Approve after review with: pnpm kyberion approve ${record.id} ${record.storageChannel}`
  );
  console.log(
    `Run after approval with: pnpm pipeline --input ${inputPath} --project-trust-approval ${record.id}`
  );
}

export function resolveActuatorPath(actuatorPath: string): string | null {
  const candidates = [path.join(rootDir, 'dist', actuatorPath, 'src')];

  for (const candidate of candidates) {
    if (!safeExistsSync(candidate)) {
      continue;
    }

    const files = safeReaddir(candidate);
    const main = files.find((file) => file === 'index.js' || file === 'main.js');
    if (main) {
      return path.join(candidate, main);
    }
  }

  return null;
}

function findActuator(actuators: ActuatorRecord[], name: string): ActuatorRecord | undefined {
  const normalizedName = name.trim().toLowerCase();
  return actuators.find((actuator) => actuator.name.toLowerCase() === normalizedName);
}

function runActuator(
  actuators: ActuatorRecord[],
  actuatorName: string | undefined,
  rawArgs: string[],
  missionId?: string
) {
  if (!actuatorName) {
    throw new Error('Missing actuator name. Try `pnpm kyberion list`.');
  }

  const actuator = findActuator(actuators, actuatorName);
  if (!actuator) {
    const suggestions = searchActuators(actuators, actuatorName)
      .slice(0, 5)
      .map((match) => match.name);
    const suffix = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    throw new Error(`Actuator "${actuatorName}" not found.${suffix}`);
  }

  const { branchId, args } = extractBranchArg(rawArgs);
  printBranchBanner(branchId);

  const script = resolveActuatorPath(actuator.path);
  if (!script) {
    throw new Error(
      `Actuator "${actuator.name}" is indexed but has no runnable build output. Run \`pnpm build\` first.`
    );
  }

  const forwardedArgs = args.filter((arg) => arg !== '--');
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
    const isTimeout = /timed?\s*out|timeout|deadline|ETIMEDOUT/i.test(err.message || '');
    const timeoutHint = isTimeout
      ? ' (30-minute timeout exceeded — for long-running tasks, run the actuator directly: `node dist/<path>/src/index.js --input <file>`)'
      : '';
    process.stderr.write(
      chalk.red(
        `\n${t('cli_error_execution_failed').replace('{message}', err.message)}${timeoutHint}\n`
      )
    );
    if (err.stdout) {
      process.stdout.write(err.stdout.toString());
    }
    throw err;
  }
}

const READ_ONLY_COMMANDS_WITHOUT_RUNTIME_BOOTSTRAP = new Set([
  'help',
  '--help',
  '-h',
  'list',
  'search',
  'info',
  'examples',
  'mobile-profiles',
  'web-profiles',
  'artifact',
  'open-artifact',
  'packet',
  'approvals',
  'project-trust',
]);

/**
 * LC-13: metadata/status commands must not pay the provider, embedding, or
 * voice bootstrap cost. `list --check` is the explicit exception because it
 * asks for live runtime capability probes.
 */
export function shouldBootstrapRuntime(args: string[]): boolean {
  const normalizedArgs = stripNpmSeparatorArg(stripLocaleArg(args));
  const command = normalizedArgs[0] || 'help';
  if (command === 'list') return normalizedArgs.includes('--check');
  if (command === 'task' && normalizedArgs[1] === 'scenario') return false;
  return !READ_ONLY_COMMANDS_WITHOUT_RUNTIME_BOOTSTRAP.has(command);
}

export async function main(args: string[] = []) {
  activeCliArgs = [...args];
  const missionId = process.env.MISSION_ID;
  printMissionContextBanner(missionId);

  const actuators = loadActuators();
  const locale = resolveLocale(args);
  const normalizedArgs = stripNpmSeparatorArg(stripLocaleArg(args));
  const [command = 'help', firstArg, ...restArgs] = normalizedArgs;

  if (shouldBootstrapRuntime(normalizedArgs)) {
    installReasoningBackends();
    installPythonVoiceBridgeIfAvailable();
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(actuators, locale);
    return;
  }

  if (command === 'list') {
    printActuatorList(actuators);
    const hasCheck = normalizedArgs.includes('--check');
    if (hasCheck) {
      const statuses = await checkAllActuatorCapabilities();
      console.log('\n=== Runtime Capability Check ===');
      for (const status of statuses) {
        const available = status.capabilities.filter((c) => c.available).length;
        const total = status.capabilities.length;
        const icon = available === total ? '\u2705' : available > 0 ? '\u26A0\uFE0F' : '\u274C';
        console.log(
          `${icon} ${status.actuatorId} (v${status.version}): ${available}/${total} ops available`
        );
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
      throw new Error('Missing actuator name. Try `pnpm kyberion list`.');
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
      throw new Error(
        'Missing artifact path. Try `pnpm kyberion artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
      );
    }

    printArtifactInfo(firstArg);
    return;
  }

  if (command === 'open-artifact') {
    if (!firstArg) {
      throw new Error(
        'Missing artifact path. Try `pnpm kyberion open-artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
      );
    }

    openArtifact(firstArg);
    return;
  }

  if (command === 'packet') {
    if (!firstArg) {
      throw new Error(
        'Missing packet path. Try `pnpm kyberion packet active/shared/tmp/orchestrator/operator-interaction-packet.json`.'
      );
    }

    printInteractionPacketFile(firstArg);
    return;
  }

  if (command === 'accept-next-action') {
    if (!firstArg || !restArgs[0]) {
      throw new Error('Usage: pnpm kyberion accept-next-action <packet-path> <action-id>');
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

  if (command === 'project-trust') {
    if (firstArg !== 'request' || !restArgs[0]) {
      throw new Error('Usage: pnpm kyberion project-trust request <pipeline-path> [--json]');
    }
    requestProjectTrust(restArgs[0], restArgs.includes('--json'));
    return;
  }

  if (command === 'email') {
    await handleEmailWorkflowCommand(firstArg, restArgs, locale);
    return;
  }

  if (command === 'calendar') {
    await handleCalendarWorkflowCommand(firstArg, restArgs, locale);
    return;
  }

  if (command === 'task') {
    await handleTaskCommand(firstArg, restArgs, locale);
    return;
  }

  if (command === 'offboard') {
    await handleOffboardCommand(firstArg, restArgs, locale);
    return;
  }

  if (command === 'run') {
    runActuator(actuators, firstArg, restArgs, missionId);
    return;
  }

  if (command === 'preview') {
    const filePath = firstArg;
    if (!filePath) {
      throw new ScriptExitError(1, 'Usage: pnpm kyberion preview <pipeline.json>');
    }
    const resolvedPreviewPath = pathResolver.rootResolve(filePath);
    assertPipelinePreviewResourcePath(resolvedPreviewPath);
    const content = readTextFile(resolvedPreviewPath);
    const pipeline = parseSafeJsonInput(content, 'Pipeline preview file');
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
    if (restArgs.includes('--preview-graph') && preview.graph) {
      console.log(`\n=== Effective Graph (Mermaid) ===\n${preview.graph.mermaid}`);
    }
    if (!preview.valid) throw new ScriptExitError(1, '', true);
    return;
  }

  if (command === 'intent') {
    // Free-text compatibility route → canonical ask resolution/execution
    // Usage: pnpm kyberion intent "仮説を発散させて" [--run|--clarify]
    const flags = normalizedArgs.filter((a) => a.startsWith('--'));
    const words = normalizedArgs.slice(1).filter((a) => !a.startsWith('--'));
    const utterance = words.join(' ').trim();
    if (!utterance) {
      throw new ScriptExitError(
        1,
        'Usage: pnpm kyberion intent "<utterance>" [--run|--clarify]\n  --run  Compatibility alias; route through governed `kyberion ask` execution\n  --clarify  Print a clarification packet for the utterance'
      );
    }
    const doClarify = flags.includes('--clarify');

    // Both the historical read-only form and --run now use one governed
    // surface route. `kyberion ask` decides whether to explain, clarify, or
    // execute after the canonical resolver and approval gates have run.
    await routeLegacyIntentToAsk(utterance, doClarify ? 'clarify' : 'explain');
    return;
  }

  if (command === 'schedule') {
    const subAction = firstArg; // register, list, remove
    if (subAction === 'list') {
      const schedules = listScheduledPipelines();
      if (schedules.length === 0) {
        console.log('No scheduled pipelines.');
      } else {
        console.log(`\n=== Scheduled Pipelines (${schedules.length}) ===`);
        for (const s of schedules) {
          const status = s.enabled ? '\u2705' : '\u23F8\uFE0F';
          const trigger =
            s.trigger.type === 'cron'
              ? `cron: ${s.trigger.cron}`
              : `interval: ${s.trigger.intervalMs}ms`;
          const last = s.lastRun ? ` | last: ${s.lastRun} (${s.lastStatus})` : '';
          console.log(`${status} ${s.id} \u2014 ${s.name} [${s.actuator}] ${trigger}${last}`);
          console.log(`   pipeline: ${s.pipelinePath}`);
        }
      }
    } else if (subAction === 'register') {
      // pnpm kyberion schedule register <id> <pipeline-path> <actuator> <cron>
      const [id, pipelinePath, actuator, cron] = restArgs;
      if (!id || !pipelinePath || !actuator || !cron) {
        throw new ScriptExitError(
          1,
          'Usage: pnpm kyberion schedule register <id> <pipeline-path> <actuator> "<cron>"'
        );
      }
      registerScheduledPipeline({
        id,
        name: id,
        pipelinePath,
        actuator,
        trigger: { type: 'cron', cron },
        enabled: true,
      });
      console.log(`Registered: ${id} \u2192 ${pipelinePath} [${actuator}] cron: ${cron}`);
    } else if (subAction === 'remove') {
      const id = restArgs[0];
      if (!id) {
        throw new ScriptExitError(1, 'Usage: pnpm kyberion schedule remove <id>');
      }
      unregisterScheduledPipeline(id);
      console.log(`Removed: ${id}`);
    } else {
      console.log('Usage: pnpm kyberion schedule [list|register|remove]');
    }
    return;
  }

  throw new Error(t('cli_error_unknown_command', locale).replace('{command}', command));
}

export const runCli = defineScript({
  name: 'cli',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (isDirectScript(import.meta.url, 'cli.ts') || isDirectScript(import.meta.url, 'cli.js'))
  void runCli();
