#!/usr/bin/env node
import {
  logger,
  pathResolver,
  resolveOperatorDisplayName,
  safeExistsSync,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeReaddir,
  safeStat,
  loadActuatorManifestCatalog,
  installReasoningBackends,
  renderStatus,
} from '@agent/core';
import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import {
  executeEmailDelivery,
  generateEmailReplyDraft,
  organizeEmailInbox,
  listEmailAccountProviders,
  readEmailDraftArtifact,
  readGwsAuthStatus,
  resolveEmailTriagePath,
} from '@agent/core/email-workflow';
import {
  createCalendarEvent,
  listCalendarAgenda,
  listCalendars,
  queryCalendarFreeBusy,
  readM365AuthStatus,
} from '@agent/core/calendar-workflow';
import {
  assertValidMobileAppProfileIndex,
  assertValidWebAppProfileIndex,
} from '@agent/core/app-profiles';
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
    | 'execute_now'
    | 'inspect'
    | 'clarify'
    | 'start_mission'
    | 'resume_mission';
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
const vocabularyPath = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');

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
  if (normalized && !normalized.startsWith('en') && normalized !== 'c' && normalized !== 'posix') {
    process.stderr.write(`Note: locale "${normalized}" is not available; using "en".\n`);
  }
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

function getCalendarProvider(
  options: Record<string, string | boolean>
): 'google-workspace' | 'm365' {
  const provider =
    typeof options['--provider'] === 'string' ? options['--provider'] : 'google-workspace';
  return provider === 'm365' ? 'm365' : 'google-workspace';
}

export function stripNpmSeparatorArg(args: string[]): string[] {
  return args.filter((arg) => arg !== '--');
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
    process.stderr.write(
      chalk.cyan(
        `\n🧠 BRAIN: Context hydrated from mission "${missionId}" (Status: ${state.status || 'unknown'})\n`
      )
    );
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
    process.stderr.write(
      chalk.red(`\n${t('cli_error_branch_not_found').replace('{branch}', branchId)}\n`)
    );
    return;
  }

  process.stderr.write(
    chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"\n`)
  );
}

function printHeader(locale = resolveLocale()) {
  console.log(chalk.yellow('\n🌌 KYBERION CONSOLE v2.2 [SECURE-IO ENFORCED]'));
  console.log(chalk.gray(t('cli_header_tagline', locale) + '\n'));
}

function printHelp(actuators: ActuatorRecord[], locale = resolveLocale()) {
  printHeader(locale);
  console.log(t('cli_help_usage', locale));
  console.log('');
  console.log(t('cli_help_sec_actuators', locale));
  console.log(t('cli_help_list', locale));
  console.log(t('cli_help_search', locale));
  console.log(t('cli_help_info', locale));
  console.log(t('cli_help_examples_cmd', locale));
  console.log(t('cli_help_mobile_profiles', locale));
  console.log(t('cli_help_web_profiles', locale));
  console.log(t('cli_help_run', locale));
  console.log('');
  console.log(t('cli_help_sec_pipelines', locale));
  console.log(t('cli_help_preview', locale));
  console.log(t('cli_help_schedule_list', locale));
  console.log('  schedule register <id> <pipeline> <actuator> "<cron>"');
  console.log(t('cli_help_schedule_register_desc', locale));
  console.log(t('cli_help_schedule_remove', locale));
  console.log('');
  console.log(t('cli_help_sec_artifacts', locale));
  console.log(t('cli_help_artifact', locale));
  console.log(t('cli_help_open_artifact', locale));
  console.log('');
  console.log(t('cli_help_intent', locale));
  console.log(t('cli_help_task_summary', locale));
  console.log('');
  console.log(t('cli_help_sec_packets', locale));
  console.log(t('cli_help_packet', locale));
  console.log(t('cli_help_accept_next', locale));
  console.log('');
  console.log(t('cli_help_sec_approvals', locale));
  console.log(t('cli_help_approvals', locale));
  console.log(t('cli_help_approve', locale));
  console.log(t('cli_help_reject', locale));
  console.log('');
  console.log(t('cli_help_sec_email', locale));
  console.log(t('cli_help_email_summary', locale));
  console.log(t('cli_help_email_status', locale));
  console.log(t('cli_help_email_draft', locale));
  console.log(t('cli_help_email_latest', locale));
  console.log(t('cli_help_email_deliver', locale));
  console.log(t('cli_help_email_archive', locale));
  console.log(t('cli_help_calendar_summary', locale));
  console.log(t('cli_help_calendar_status', locale));
  console.log(t('cli_help_calendar_list', locale));
  console.log(t('cli_help_calendar_agenda', locale));
  console.log(t('cli_help_calendar_freebusy', locale));
  console.log(t('cli_help_calendar_create', locale));
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  npm run cli -- list');
  console.log('  npm run cli -- search browser');
  console.log('  npm run cli -- run file-actuator -- --help');
  console.log('  npm run cli -- preview pipelines/verify-session.json');
  console.log('  npm run cli -- approvals');
  console.log('  npm run cli -- approve <request-id>');
  console.log('  npm run cli -- email status');
  console.log('  npm run cli -- email draft --triage-file active/shared/tmp/email-inbox-triage.md');
  console.log('  npm run cli -- calendar status');
  console.log('  npm run cli -- calendar list-calendars');
  console.log('  npm run cli -- calendar agenda --calendar-id primary --days 7');
  console.log('  npm run cli -- task plan "明日の会議資料とメール下書きを作って"');
  console.log('');
  console.log(t('cli_help_first_run', locale));
  console.log(t('cli_help_onboard', locale));
  console.log(t('cli_help_doctor', locale));
  console.log(t('cli_help_capabilities', locale));
  console.log(t('cli_help_journal', locale));
  console.log('');
  console.log(`${t('cli_help_indexed_actuators', locale)} ${actuators.length}`);
}

function printEmailHelp(locale = resolveLocale()): void {
  printHeader(locale);
  console.log(t('cli_help_email_usage', locale));
  console.log('');
  console.log(t('cli_help_commands', locale));
  console.log(t('cli_help_email_status_short', locale));
  console.log(t('cli_help_email_draft_short', locale));
  console.log(t('cli_help_email_latest_short', locale));
  console.log(t('cli_help_email_deliver_short', locale));
  console.log(t('cli_help_email_archive_short', locale));
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  npm run cli -- email status');
  console.log('  npm run cli -- email draft --triage-file active/shared/tmp/email-inbox-triage.md');
  console.log('  npm run cli -- email latest-draft');
  console.log(
    '  npm run cli -- email deliver --draft-mode --body-file active/shared/runtime/presence-studio/email-drafts/latest.md'
  );
  console.log(
    '  npm run cli -- email deliver --approved --body-file active/shared/runtime/presence-studio/email-drafts/latest.md'
  );
  console.log('  npm run cli -- email archive-inbox --apply');
}

function printCalendarHelp(locale = resolveLocale()): void {
  printHeader(locale);
  console.log(t('cli_help_calendar_usage', locale));
  console.log('');
  console.log(t('cli_help_commands', locale));
  console.log(t('cli_help_calendar_status_short', locale));
  console.log(t('cli_help_calendar_list_short', locale));
  console.log(t('cli_help_calendar_agenda_short', locale));
  console.log(t('cli_help_calendar_freebusy_short', locale));
  console.log(t('cli_help_calendar_create_short', locale));
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  npm run cli -- calendar status');
  console.log('  npm run cli -- calendar status --provider m365');
  console.log('  npm run cli -- calendar list-calendars');
  console.log('  npm run cli -- calendar list-calendars --provider m365');
  console.log('  npm run cli -- calendar agenda --calendar-id primary --days 7');
  console.log('  npm run cli -- calendar agenda --provider m365 --calendar-id primary --days 7');
  console.log(
    '  npm run cli -- calendar freebusy --calendar-ids primary,team@example.com --time-min 2026-06-21T09:00:00+09:00 --time-max 2026-06-21T18:00:00+09:00'
  );
  console.log(
    '  npm run cli -- calendar create-event --summary "Planning" --start 2026-06-22T13:00:00+09:00 --end 2026-06-22T14:00:00+09:00 --with-meet'
  );
}

function printTaskHelp(locale = resolveLocale()): void {
  printHeader(locale);
  console.log(t('cli_help_task_usage', locale));
  console.log('');
  console.log(t('cli_help_commands', locale));
  console.log(t('cli_help_task_plan_short', locale));
  console.log(t('cli_help_task_start_short', locale));
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  npm run cli -- task plan "明日の会議資料とメール下書きを作って"');
  console.log(
    '  npm run cli -- task plan "ブラウザで購入して決済して" --output active/shared/tmp/purchase-plan.json'
  );
  console.log('  npm run cli -- task start "連携システムから情報収集して資料を作って"');
}

function parseEmailWorkflowOptions(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[current] = true;
      continue;
    }
    parsed[current] = next;
    index += 1;
  }
  return parsed;
}

function parseTaskRequest(args: string[]): { request: string; outputPath?: string } {
  const options = parseEmailWorkflowOptions(args);
  const requestOption = typeof options['--request'] === 'string' ? options['--request'] : '';
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('--')) {
      const next = args[index + 1];
      if (next && !next.startsWith('--')) index += 1;
      continue;
    }
    positional.push(value);
  }
  return {
    request: (requestOption || positional.join(' ')).trim(),
    outputPath: typeof options['--output'] === 'string' ? options['--output'] : undefined,
  };
}

async function handleTaskCommand(
  subcommand: string | undefined,
  args: string[],
  locale = resolveLocale()
): Promise<void> {
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printTaskHelp(locale);
    return;
  }
  if (subcommand !== 'plan' && subcommand !== 'start') {
    throw new Error(`Unknown task subcommand: ${subcommand}`);
  }

  const { request, outputPath } = parseTaskRequest(args);
  if (!request) {
    throw new Error('task request is required; pass it as text or with --request');
  }

  const {
    buildProductivityTaskPlan,
    classifyTaskSessionIntent,
    createTaskSession,
    saveTaskSession,
    validateTaskSession,
  } = await import('@agent/core');
  const plan = buildProductivityTaskPlan(request);

  if (subcommand === 'plan') {
    if (outputPath) {
      const absoluteOutputPath = pathResolver.rootResolve(outputPath);
      safeMkdir(path.dirname(absoluteOutputPath), { recursive: true });
      safeWriteFile(absoluteOutputPath, `${JSON.stringify(plan, null, 2)}\n`);
    }
    console.log(JSON.stringify(outputPath ? { ...plan, plan_path: outputPath } : plan, null, 2));
    return;
  }

  const classified = classifyTaskSessionIntent(request);
  const composite = plan.domains.length > 1;
  const missing = [
    ...new Set([...(classified?.requirements?.missing || []), ...plan.missing_inputs]),
  ];
  const session = createTaskSession({
    surface: 'terminal',
    taskType: composite ? 'analysis' : classified?.taskType || 'analysis',
    status: missing.length
      ? 'collecting_requirements'
      : plan.approval.required
        ? 'awaiting_confirmation'
        : 'planning',
    requiresApproval: plan.approval.required,
    goal: classified?.goal || {
      summary: request,
      success_condition: 'The requested productivity task is completed with governed evidence.',
    },
    intentId: composite ? undefined : classified?.intentId,
    requirements: {
      missing,
      collected: classified?.requirements?.collected || {},
    },
    payload: composite
      ? {
          productivity_plan_kind: plan.kind,
          detected_domains: plan.domains,
          recommended_pipeline: plan.recommended_pipeline,
        }
      : classified?.payload,
  });
  const validation = validateTaskSession(session);
  if (!validation.valid) {
    throw new Error(`generated task session is invalid: ${validation.errors.join('; ')}`);
  }

  const planPath =
    outputPath || `active/shared/tmp/productivity-task-plans/${session.session_id}.json`;
  const absolutePlanPath = pathResolver.rootResolve(planPath);
  safeMkdir(path.dirname(absolutePlanPath), { recursive: true });
  safeWriteFile(absolutePlanPath, `${JSON.stringify(plan, null, 2)}\n`);
  const sessionPath = saveTaskSession(session);
  console.log(
    JSON.stringify(
      {
        status: 'task_session_created',
        session_id: session.session_id,
        session_path: path.relative(rootDir, sessionPath),
        plan_path: planPath,
        external_effects_executed: false,
      },
      null,
      2
    )
  );
}

async function handleEmailWorkflowCommand(
  subcommand: string | undefined,
  args: string[],
  locale = resolveLocale()
): Promise<void> {
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printEmailHelp(locale);
    return;
  }
  const options = parseEmailWorkflowOptions(args);

  if (subcommand === 'status') {
    printHeader();
    console.log(JSON.stringify({ accounts: listEmailAccountProviders() }, null, 2));
    return;
  }

  if (subcommand === 'latest-draft') {
    printHeader();
    console.log(JSON.stringify(readEmailDraftArtifact(), null, 2));
    return;
  }

  if (subcommand === 'draft') {
    const triageFile =
      typeof options['--triage-file'] === 'string'
        ? options['--triage-file']
        : resolveEmailTriagePath();
    const triageText = String(
      safeReadFile(pathResolver.rootResolve(triageFile), { encoding: 'utf8' }) || ''
    ).trim();
    if (!triageText) {
      throw new Error(`triage text not found at ${triageFile}`);
    }
    const backend = (await import('@agent/core')).getReasoningBackend();
    const result = await generateEmailReplyDraft({
      requestId: typeof options['--request-id'] === 'string' ? options['--request-id'] : undefined,
      recipient: typeof options['--to'] === 'string' ? options['--to'] : undefined,
      subjectInput: typeof options['--subject'] === 'string' ? options['--subject'] : undefined,
      tone: typeof options['--tone'] === 'string' ? options['--tone'] : undefined,
      triageText,
      delegateTask: backend.delegateTask.bind(backend),
      backendName: (backend as any)?.name || 'unknown',
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === 'deliver') {
    const bodyFile = typeof options['--body-file'] === 'string' ? options['--body-file'] : '';
    const bodyMarkdown =
      typeof options['--body-markdown'] === 'string'
        ? options['--body-markdown']
        : bodyFile
          ? String(safeReadFile(pathResolver.rootResolve(bodyFile), { encoding: 'utf8' }) || '')
          : '';
    if (!bodyMarkdown.trim()) {
      throw new Error('body_markdown is required; provide --body-markdown or --body-file');
    }
    const draftMode = options['--draft-mode'] === true || options['--draft-mode'] === 'true';
    const approved = options['--approved'] === true || options['--approved'] === 'true';
    if (!draftMode && !approved) {
      throw new Error(
        'approval is required before sending an email; add --approved or use --draft-mode'
      );
    }
    const replyModeValue =
      typeof options['--reply-mode'] === 'string' ? options['--reply-mode'] : 'new';
    const result = await executeEmailDelivery({
      approved,
      draft_mode: draftMode,
      reply_mode:
        replyModeValue === 'reply' || replyModeValue === 'reply-all' ? replyModeValue : 'new',
      body_markdown: bodyMarkdown,
      subject: typeof options['--subject'] === 'string' ? options['--subject'] : undefined,
      to: typeof options['--to'] === 'string' ? options['--to'] : undefined,
      message_id: typeof options['--message-id'] === 'string' ? options['--message-id'] : undefined,
      account:
        typeof options['--account'] === 'string'
          ? options['--account']
          : typeof options['--provider'] === 'string'
            ? options['--provider']
            : 'auto',
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === 'archive-inbox') {
    const result = await organizeEmailInbox({
      account:
        typeof options['--account'] === 'string'
          ? options['--account']
          : typeof options['--provider'] === 'string'
            ? options['--provider']
            : 'auto',
      max_messages:
        Number(typeof options['--max-messages'] === 'string' ? options['--max-messages'] : '50') ||
        50,
      min_count:
        Number(typeof options['--min-count'] === 'string' ? options['--min-count'] : '2') || 2,
      apply: options['--apply'] === true || options['--apply'] === 'true',
      message_ids:
        typeof options['--message-ids'] === 'string'
          ? options['--message-ids']
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown email subcommand: ${subcommand}`);
}

async function handleCalendarWorkflowCommand(
  subcommand: string | undefined,
  args: string[],
  locale = resolveLocale()
): Promise<void> {
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printCalendarHelp(locale);
    return;
  }

  const options = parseEmailWorkflowOptions(args);

  if (subcommand === 'status') {
    const provider = getCalendarProvider(options);
    const status = provider === 'm365' ? await readM365AuthStatus() : readGwsAuthStatus();
    printHeader();
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (subcommand === 'list-calendars') {
    const result = await listCalendars(getCalendarProvider(options));
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === 'agenda') {
    const provider = getCalendarProvider(options);
    const result = await listCalendarAgenda({
      provider,
      calendar_id:
        typeof options['--calendar-id'] === 'string' ? options['--calendar-id'] : 'primary',
      days: Number(typeof options['--days'] === 'string' ? options['--days'] : '7') || 7,
      max_results:
        Number(typeof options['--max-results'] === 'string' ? options['--max-results'] : '20') ||
        20,
      query: typeof options['--query'] === 'string' ? options['--query'] : undefined,
      time_min: typeof options['--time-min'] === 'string' ? options['--time-min'] : undefined,
      time_max: typeof options['--time-max'] === 'string' ? options['--time-max'] : undefined,
      time_zone: typeof options['--time-zone'] === 'string' ? options['--time-zone'] : undefined,
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === 'freebusy') {
    const provider = getCalendarProvider(options);
    const timeMin = typeof options['--time-min'] === 'string' ? options['--time-min'] : '';
    const timeMax = typeof options['--time-max'] === 'string' ? options['--time-max'] : '';
    if (!timeMin || !timeMax) {
      throw new Error('time_min and time_max are required for freebusy');
    }
    const calendarIds =
      typeof options['--calendar-ids'] === 'string'
        ? options['--calendar-ids']
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    const result = await queryCalendarFreeBusy({
      provider,
      calendar_id:
        typeof options['--calendar-id'] === 'string' ? options['--calendar-id'] : 'primary',
      calendar_ids: calendarIds,
      time_min: timeMin,
      time_max: timeMax,
      time_zone: typeof options['--time-zone'] === 'string' ? options['--time-zone'] : undefined,
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === 'create-event') {
    const provider = getCalendarProvider(options);
    const summary = typeof options['--summary'] === 'string' ? options['--summary'] : '';
    const start = typeof options['--start'] === 'string' ? options['--start'] : '';
    const end = typeof options['--end'] === 'string' ? options['--end'] : '';
    if (!summary || !start || !end) {
      throw new Error('summary, start, and end are required for create-event');
    }
    const attendees =
      typeof options['--attendees'] === 'string'
        ? options['--attendees']
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    const sendUpdatesValue =
      typeof options['--send-updates'] === 'string' ? options['--send-updates'] : '';
    const result = await createCalendarEvent({
      provider,
      calendar_id:
        typeof options['--calendar-id'] === 'string' ? options['--calendar-id'] : 'primary',
      summary,
      start,
      end,
      description:
        typeof options['--description'] === 'string' ? options['--description'] : undefined,
      location: typeof options['--location'] === 'string' ? options['--location'] : undefined,
      attendees,
      time_zone: typeof options['--time-zone'] === 'string' ? options['--time-zone'] : undefined,
      send_updates:
        sendUpdatesValue === 'all' ||
        sendUpdatesValue === 'externalOnly' ||
        sendUpdatesValue === 'none'
          ? sendUpdatesValue
          : undefined,
      with_meet: options['--with-meet'] === true || options['--with-meet'] === 'true',
      conference_request_id:
        typeof options['--conference-request-id'] === 'string'
          ? options['--conference-request-id']
          : undefined,
    });
    printHeader();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown calendar subcommand: ${subcommand}`);
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
  if (!safeExistsSync(indexPath)) {
    return [];
  }
  const parsed = readJsonFile<MobileAppProfileIndex>(indexPath);
  assertValidMobileAppProfileIndex(parsed, indexPath, (relativePath) =>
    safeExistsSync(path.join(rootDir, relativePath))
  );
  return parsed.profiles;
}

function resolveWebAppProfileIndexPath(): string {
  return pathResolver.knowledge('product/orchestration/web-app-profiles/index.json');
}

function loadWebAppProfiles(): WebAppProfileIndexRecord[] {
  const indexPath = resolveWebAppProfileIndexPath();
  if (!safeExistsSync(indexPath)) return [];
  const parsed = readJsonFile<{ profiles: WebAppProfileIndexRecord[] }>(indexPath);
  assertValidWebAppProfileIndex(parsed, indexPath, (relativePath) =>
    safeExistsSync(path.join(rootDir, relativePath))
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
      `Usage: npm run cli -- ${command} <request-id> [storage-channel]\nRun \`npm run cli -- approvals\` first to list pending request IDs.`
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
    note: `decision submitted from terminal via npm run cli -- ${command}`,
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
    throw new Error('Missing actuator name. Try `npm run cli -- list`.');
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

export async function main(args = process.argv.slice(2)) {
  installReasoningBackends();
  installPythonVoiceBridgeIfAvailable();

  const missionId = process.env.MISSION_ID;
  printMissionContextBanner(missionId);

  const actuators = loadActuators();
  const locale = resolveLocale(args);
  const normalizedArgs = stripNpmSeparatorArg(stripLocaleArg(args));
  const [command = 'help', firstArg, ...restArgs] = normalizedArgs;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(actuators, locale);
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
      throw new Error(
        'Missing artifact path. Try `npm run cli -- artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
      );
    }

    printArtifactInfo(firstArg);
    return;
  }

  if (command === 'open-artifact') {
    if (!firstArg) {
      throw new Error(
        'Missing artifact path. Try `npm run cli -- open-artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
      );
    }

    openArtifact(firstArg);
    return;
  }

  if (command === 'packet') {
    if (!firstArg) {
      throw new Error(
        'Missing packet path. Try `npm run cli -- packet active/shared/tmp/orchestrator/operator-interaction-packet.json`.'
      );
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

  if (command === 'run') {
    runActuator(actuators, firstArg, restArgs, missionId);
    return;
  }

  if (command === 'preview') {
    const { previewPipeline } = await import('@agent/core');
    const filePath = firstArg;
    if (!filePath) {
      console.error('Usage: pnpm cli preview <pipeline.json>');
      process.exit(1);
    }
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

  if (command === 'intent') {
    // Free-text → intent resolution → optional pipeline execution
    // Usage: pnpm cli intent "仮説を発散させて" [--run|--clarify]
    const flags = normalizedArgs.filter((a) => a.startsWith('--'));
    const words = normalizedArgs.slice(1).filter((a) => !a.startsWith('--'));
    const utterance = words.join(' ').trim();
    if (!utterance) {
      console.error('Usage: pnpm cli intent "<utterance>" [--run|--clarify]');
      console.error('  --run  Execute the resolved pipeline immediately');
      console.error('  --clarify  Print a clarification packet for the utterance');
      process.exit(1);
    }
    const doRun = flags.includes('--run');
    const doClarify = flags.includes('--clarify');

    const { resolveIntentResolutionPacket, loadStandardIntentCatalog } =
      await import('@agent/core/intent-resolution');
    const { resolveQuestionInteractionPacket } = await import('@agent/core/question-resolver');
    const packet = resolveIntentResolutionPacket(utterance);

    console.log(`\n=== Intent Resolution ===`);
    console.log(`Utterance  : "${packet.utterance}"`);

    if (!packet.selected_intent_id) {
      console.log(`Result     : No intent matched (confidence below threshold)`);
      if (packet.candidates.length > 0) {
        console.log(`\nTop candidates:`);
        for (const c of packet.candidates.slice(0, 5)) {
          console.log(
            `  ${c.confidence.toFixed(2)}  ${c.intent_id}  — ${c.reasons[0] ?? 'heuristic'}`
          );
        }
      }
      const clarificationPacket = resolveQuestionInteractionPacket(
        {
          text: utterance,
          confidence: packet.selected_confidence,
        },
        undefined,
        undefined
      );
      if (clarificationPacket) {
        console.log('\nClarification packet:');
        printOperatorPacket(clarificationPacket);
      } else {
        console.log(
          '\nNext step: rephrase the utterance, or run `pnpm cli -- intent --clarify "<utterance>"` to inspect missing inputs.'
        );
      }
      process.exit(0);
    }

    const catalog = loadStandardIntentCatalog();
    const intent = catalog.find((i) => i.id === packet.selected_intent_id);

    console.log(
      `Selected   : ${packet.selected_intent_id} (confidence: ${packet.selected_confidence})`
    );
    if (intent?.description) console.log(`Description: ${intent.description}`);
    if (intent?.risk_profile) console.log(`Risk       : ${intent.risk_profile}`);
    if (intent?.plan_outline?.length) {
      console.log(`\nPlan:`);
      intent.plan_outline.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
    }
    if (intent?.pipeline?.length) {
      console.log(`\nPipeline steps (${intent.pipeline.length}):`);
      intent.pipeline.forEach((s, i) => console.log(`  ${i + 1}. ${s.op}`));
    }
    if (packet.bundle_candidates?.length) {
      console.log(`\nCapability bundles:`);
      for (const b of packet.bundle_candidates) {
        console.log(`  [${b.status}] ${b.bundle_id} — ${b.summary}`);
      }
    }

    if (doClarify) {
      const clarificationPacket = resolveQuestionInteractionPacket(
        {
          text: utterance,
          intentId: packet.selected_intent_id,
          confidence: packet.selected_confidence,
          executionShape: undefined,
        },
        undefined,
        undefined
      );
      if (clarificationPacket) {
        console.log('\nClarification packet:');
        printOperatorPacket(clarificationPacket);
      } else {
        console.log(
          '\nClarification packet: none — the request is already clear enough to execute.'
        );
      }
    }

    if (doRun && intent?.pipeline?.length) {
      const { execFileSync } = await import('node:child_process');
      const tempPipeline = {
        action: 'pipeline',
        name: `Intent dispatch: ${packet.selected_intent_id}`,
        pipeline_id: `intent-${packet.selected_intent_id}`,
        steps: intent.pipeline,
      };
      const tempPath = pathResolver.rootResolve(
        `active/shared/tmp/intent-dispatch-${packet.selected_intent_id}-${Date.now()}.json`
      );
      safeWriteFile(tempPath, JSON.stringify(tempPipeline, null, 2));
      console.log(`\nRunning: node dist/scripts/run_pipeline.js --input ${tempPath}`);
      try {
        execFileSync('node', ['dist/scripts/run_pipeline.js', '--input', tempPath], {
          stdio: 'inherit',
          cwd: pathResolver.rootDir(),
        });
      } catch {
        process.exit(1);
      }
    } else if (doRun) {
      console.log(
        `\nNote: intent "${packet.selected_intent_id}" has no inline pipeline (execution_shape: ${intent?.execution_shape ?? 'unknown'}). Use a task session instead: pnpm mission create --intent-id ${packet.selected_intent_id}`
      );
    }

    process.exit(0);
  }

  if (command === 'schedule') {
    const subAction = firstArg; // register, list, remove
    const { registerScheduledPipeline, unregisterScheduledPipeline, listScheduledPipelines } =
      await import('@agent/core');

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
      // pnpm cli schedule register <id> <pipeline-path> <actuator> <cron>
      const [id, pipelinePath, actuator, cron] = restArgs;
      if (!id || !pipelinePath || !actuator || !cron) {
        console.error('Usage: pnpm cli schedule register <id> <pipeline-path> <actuator> "<cron>"');
        process.exit(1);
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
        console.error('Usage: pnpm cli schedule remove <id>');
        process.exit(1);
      }
      unregisterScheduledPipeline(id);
      console.log(`Removed: ${id}`);
    } else {
      console.log('Usage: pnpm cli schedule [list|register|remove]');
    }
    process.exit(0);
  }

  throw new Error(t('cli_error_unknown_command', locale).replace('{command}', command));
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
