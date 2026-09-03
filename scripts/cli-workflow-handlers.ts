import * as path from 'node:path';
import chalk from 'chalk';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveLocale as resolveUnifiedLocale, type SupportedLocale } from '@agent/core/locale';
import {
  assertSafeRepositoryPath,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { t as coreT } from '@agent/core/t';
import type { VocabularyKey } from '@agent/core/t';
import { offboardScope } from '@agent/core/scope-offboarding';
import {
  buildProductivityTaskPlan,
  validateProductivityTaskPlan,
} from '@agent/core/productivity-task-plan';
import {
  classifyTaskSessionIntent,
  createTaskSession,
  saveTaskSession,
  validateTaskSession,
} from '@agent/core/task-session';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
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
import { main as taskInitMain } from './task_init.js';
import { main as taskListMain } from './task_list.js';
import { main as taskRunMain } from './task_run.js';
import { main as taskSmokeMain } from './task_smoke.js';

const rootDir = pathResolver.rootDir();

function resolveWorkflowPath(value: unknown, label: string, allowMissingLeaf = false): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function resolveLocale(): SupportedLocale {
  return resolveUnifiedLocale();
}

function t(key: VocabularyKey, locale = resolveLocale()): string {
  return coreT(key, undefined, locale);
}

function printHeader(locale = resolveLocale()): void {
  console.log(chalk.yellow('\\n🌌 KYBERION CONSOLE v2.2 [SECURE-IO ENFORCED]'));
  console.log(chalk.gray(t('cli_header_tagline', locale) + '\\n'));
}

function getCalendarProvider(
  options: Record<string, string | boolean>
): 'google-workspace' | 'm365' {
  const provider =
    typeof options['--provider'] === 'string' ? options['--provider'] : 'google-workspace';
  if (provider === 'google-workspace' || provider === 'm365') return provider;
  throw new Error(`Unsupported calendar provider: ${provider}`);
}

function printCalendarResult(result: unknown, options: Record<string, string | boolean>): void {
  if (options['--quiet'] === true) return;
  if (options['--json'] === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHeader();
  console.log(JSON.stringify(result, null, 2));
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
  console.log('  pnpm kyberion email status');
  console.log('  pnpm kyberion email draft --triage-file active/shared/tmp/email-inbox-triage.md');
  console.log('  pnpm kyberion email latest-draft');
  console.log(
    '  pnpm kyberion email deliver --draft-mode --body-file active/shared/runtime/presence-studio/email-drafts/latest.md'
  );
  console.log(
    '  pnpm kyberion email deliver --approved --body-file active/shared/runtime/presence-studio/email-drafts/latest.md'
  );
  console.log('  pnpm kyberion email archive-inbox --apply');
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
  console.log('  pnpm kyberion calendar status');
  console.log('  pnpm kyberion calendar status --provider m365');
  console.log('  pnpm kyberion calendar list-calendars');
  console.log('  pnpm kyberion calendar list-calendars --provider m365');
  console.log('  pnpm kyberion calendar agenda --calendar-id primary --days 7');
  console.log('  pnpm kyberion calendar agenda --provider m365 --calendar-id primary --days 7');
  console.log(
    '  pnpm kyberion calendar freebusy --calendar-ids primary,team@example.com --time-min 2026-06-21T09:00:00+09:00 --time-max 2026-06-21T18:00:00+09:00'
  );
  console.log(
    '  pnpm kyberion calendar create-event --summary "Planning" --start 2026-06-22T13:00:00+09:00 --end 2026-06-22T14:00:00+09:00 --with-meet'
  );
}

function printTaskHelp(locale = resolveLocale()): void {
  printHeader(locale);
  console.log(t('cli_help_task_usage', locale));
  console.log('');
  console.log(t('cli_help_commands', locale));
  console.log(t('cli_help_task_plan_short', locale));
  console.log(t('cli_help_task_start_short', locale));
  console.log('  scenario <list|init|run|smoke>  repeatable TaskScenario workflows');
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  pnpm kyberion task plan "明日の会議資料とメール下書きを作って"');
  console.log(
    '  pnpm kyberion task plan "ブラウザで購入して決済して" --output active/shared/tmp/purchase-plan.json'
  );
  console.log('  pnpm kyberion task start "連携システムから情報収集して資料を作って"');
  console.log('  pnpm kyberion task scenario list');
  console.log('  pnpm kyberion task scenario run daily-email-triage --dry-run');
}

function printTaskScenarioHelp(): void {
  console.log('Usage: pnpm kyberion task scenario <list|init|run|smoke> [options]');
  console.log('  list [--json]');
  console.log('  init <scenario-id> [--answers-json <json>] [--answers-file <path>]');
  console.log('  run <scenario-id> [--profile <path>] [--dry-run] [--json]');
  console.log('  smoke <scenario-id>');
}

function printTaskScenarioValue(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function handleTaskScenarioCommand(args: string[]): Promise<void> {
  const [subcommand, ...subcommandArgs] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printTaskScenarioHelp();
    return;
  }

  switch (subcommand) {
    case 'list':
      await taskListMain(subcommandArgs, printTaskScenarioValue, subcommandArgs.includes('--json'));
      return;
    case 'init':
      await taskInitMain(subcommandArgs);
      return;
    case 'run':
      await taskRunMain(subcommandArgs, printTaskScenarioValue, subcommandArgs.includes('--json'));
      return;
    case 'smoke':
      await taskSmokeMain(subcommandArgs, console.log);
      return;
    default:
      throw new Error(`Unknown TaskScenario subcommand: ${subcommand}`);
  }
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

function printOffboardHelp(locale = resolveLocale()): void {
  printHeader(locale);
  console.log(t('cli_help_offboard_usage', locale));
  console.log('');
  console.log(t('cli_help_commands', locale));
  console.log(t('cli_help_offboard_dry_run_short', locale));
  console.log(t('cli_help_offboard_execute_short', locale));
  console.log(t('cli_help_offboard_restore_note', locale));
  console.log('');
  console.log(t('cli_help_examples', locale));
  console.log('  pnpm kyberion offboard tenant acme');
  console.log(
    '  pnpm kyberion offboard tenant acme --execute --approved-by founder --purpose "contract ended"'
  );
  console.log(
    '  pnpm kyberion offboard project PRJ-ALPHA --tenant-slug acme --organization-id ORG-ALPHA --json'
  );
}

export interface ParsedOffboardCommand {
  scopeType: 'tenant' | 'project';
  scopeId: string;
  tenantSlug?: string;
  organizationId?: string;
  mode: 'dry_run' | 'execute';
  json: boolean;
  approval?: { approved_by: string; purpose: string };
}

/**
 * AL-04 offboarding CLI arguments. Pure and exported so the fail-closed
 * rules (execute needs BOTH --approved-by and --purpose) are unit-testable
 * without touching a scope tree. The library verb refuses an unapproved
 * delete too — this is the earlier, friendlier of the two gates.
 */
export function parseOffboardArgs(args: string[]): ParsedOffboardCommand {
  const [scopeType, scopeId, ...rest] = args;
  if (scopeType !== 'tenant' && scopeType !== 'project') {
    throw new Error(
      `offboard scope must be 'tenant' or 'project' (received: ${scopeType ?? '<none>'})`
    );
  }
  if (!scopeId || scopeId.startsWith('--')) {
    throw new Error(`offboard requires a ${scopeType} id`);
  }

  const options = parseEmailWorkflowOptions(rest);
  const mode = options['--execute'] === true ? 'execute' : 'dry_run';
  const json = options['--json'] === true;
  const tenantSlug =
    typeof options['--tenant-slug'] === 'string' ? options['--tenant-slug'] : undefined;
  const organizationId =
    typeof options['--organization-id'] === 'string' ? options['--organization-id'] : undefined;
  const approvedBy = typeof options['--approved-by'] === 'string' ? options['--approved-by'] : '';
  const purpose = typeof options['--purpose'] === 'string' ? options['--purpose'] : '';

  if (mode === 'dry_run') {
    return {
      scopeType,
      scopeId,
      ...(tenantSlug ? { tenantSlug } : {}),
      ...(organizationId ? { organizationId } : {}),
      mode,
      json,
    };
  }
  if (!approvedBy.trim() || !purpose.trim()) {
    throw new Error(
      'offboard --execute deletes a scope: it requires --approved-by <who> and --purpose "<why>". ' +
        'Run without --execute for a dry run.'
    );
  }
  return {
    scopeType,
    scopeId,
    ...(tenantSlug ? { tenantSlug } : {}),
    ...(organizationId ? { organizationId } : {}),
    mode,
    json,
    approval: { approved_by: approvedBy.trim(), purpose: purpose.trim() },
  };
}

export async function handleOffboardCommand(
  firstArg: string | undefined,
  restArgs: string[],
  locale = resolveLocale()
): Promise<void> {
  if (!firstArg || firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
    printOffboardHelp(locale);
    return;
  }

  const parsed = parseOffboardArgs([firstArg, ...restArgs]);
  const result = offboardScope({
    scopeType: parsed.scopeType,
    scopeId: parsed.scopeId,
    tenantSlug: parsed.tenantSlug,
    organizationId: parsed.organizationId,
    mode: parsed.mode,
    approval: parsed.approval
      ? { approved_by: parsed.approval.approved_by, purpose: parsed.approval.purpose }
      : undefined,
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log(`Scope: ${result.scope_type} '${result.scope_id}'  →  ${result.status}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    if (result.targets.length > 0) {
      console.log(`Targets (${result.targets.length}):`);
      for (const target of result.targets) console.log(`  - [${target.kind}] ${target.path}`);
    }
    if (result.export_path) console.log(`Exported to: ${result.export_path}`);
    if (result.soft_deleted.length > 0) {
      console.log(`Moved to active/archive/.trash/ (restorable): ${result.soft_deleted.length}`);
    }
    if (result.retired_identities) {
      console.log(`Identities retired: ${result.retired_identities}`);
    }
    if (result.status === 'dry_run') {
      console.log('');
      console.log(
        'Dry run — nothing was written. Re-run with --execute --approved-by <who> --purpose "<why>" to apply.'
      );
    }
    console.log('');
  }

  // Non-zero only for the states an operator must act on: an unapproved
  // delete attempt or a failure. A dry run and a clean offboarding exit 0,
  // and `not_found` is a legitimate "nothing to do" answer.
  if (result.status === 'approval_required' || result.status === 'error') {
    process.exitCode = 1;
  }
}

export async function handleTaskCommand(
  subcommand: string | undefined,
  args: string[],
  locale = resolveLocale()
): Promise<void> {
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printTaskHelp(locale);
    return;
  }
  if (subcommand === 'scenario') {
    await handleTaskScenarioCommand(args);
    return;
  }
  if (subcommand !== 'plan' && subcommand !== 'start') {
    throw new Error(`Unknown task subcommand: ${subcommand}`);
  }

  const { request, outputPath } = parseTaskRequest(args);
  if (!request) {
    throw new Error('task request is required; pass it as text or with --request');
  }

  const plan = buildProductivityTaskPlan(request);

  if (subcommand === 'plan') {
    if (outputPath) {
      const absoluteOutputPath = resolveWorkflowPath(outputPath, 'output path', true);
      safeMkdir(path.dirname(absoluteOutputPath), { recursive: true });
      const validatedPlan = validateProductivityTaskPlan(plan, absoluteOutputPath);
      safeWriteFile(absoluteOutputPath, `${JSON.stringify(validatedPlan, null, 2)}\n`);
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
  const absolutePlanPath = resolveWorkflowPath(planPath, 'plan path', true);
  safeMkdir(path.dirname(absolutePlanPath), { recursive: true });
  const validatedPlan = validateProductivityTaskPlan(plan, absolutePlanPath);
  safeWriteFile(absolutePlanPath, `${JSON.stringify(validatedPlan, null, 2)}\n`);
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

export async function handleEmailWorkflowCommand(
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
      safeReadFile(resolveWorkflowPath(triageFile, 'triage file'), { encoding: 'utf8' }) || ''
    ).trim();
    if (!triageText) {
      throw new Error(`triage text not found at ${triageFile}`);
    }
    const backend = getReasoningBackend();
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
          ? String(
              safeReadFile(resolveWorkflowPath(bodyFile, 'body file'), { encoding: 'utf8' }) || ''
            )
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

export async function handleCalendarWorkflowCommand(
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
    printCalendarResult(status, options);
    return;
  }

  if (subcommand === 'list-calendars') {
    const result = await listCalendars(getCalendarProvider(options));
    printCalendarResult(result, options);
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
    printCalendarResult(result, options);
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
    printCalendarResult(result, options);
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
    printCalendarResult(result, options);
    return;
  }

  throw new Error(`Unknown calendar subcommand: ${subcommand}`);
}
