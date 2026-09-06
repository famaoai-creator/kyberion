import * as path from 'node:path';
import chalk from 'chalk';
import { resolveLocale as resolveUnifiedLocale, type SupportedLocale } from '@agent/core/locale';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { t as coreT } from '@agent/core/t';
import type { VocabularyKey } from '@agent/core/t';

const rootDir = pathResolver.rootDir();

type Print = (value: unknown) => void;

let activePrint: Print = () => undefined;

export async function withPresentationOutputPrinter<T>(
  print: Print,
  callback: () => Promise<T> | T
): Promise<T> {
  const previousPrint = activePrint;
  activePrint = print;
  try {
    return await callback();
  } finally {
    activePrint = previousPrint;
  }
}

function printText(value: unknown = ''): void {
  const rendered = typeof value === 'string' ? value : String(value);
  activePrint(rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered);
}

function resolveLocale(): SupportedLocale {
  return resolveUnifiedLocale();
}

function t(key: VocabularyKey, locale = resolveLocale()): string {
  return coreT(key, undefined, locale);
}

export function printBranchBanner(branchId?: string) {
  if (!branchId) {
    return;
  }

  const patchPath = path.join(rootDir, 'knowledge/evolution/latent-wisdom', `${branchId}.json`);
  if (!safeExistsSync(patchPath)) {
    printText(chalk.red(`\n${t('cli_error_branch_not_found').replace('{branch}', branchId)}\n`));
    return;
  }

  printText(chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"\n`));
}

export function printHeader(locale = resolveLocale()) {
  printText(chalk.yellow('\n🌌 KYBERION CONSOLE v2.2 [SECURE-IO ENFORCED]'));
  printText(chalk.gray(t('cli_header_tagline', locale) + '\n'));
}

export function printHelp(actuators: { length: number }, locale = resolveLocale()) {
  printHeader(locale);
  printText(t('cli_help_usage', locale));
  printText('');
  printText(t('cli_help_sec_actuators', locale));
  printText(t('cli_help_list', locale));
  printText(t('cli_help_search', locale));
  printText(t('cli_help_info', locale));
  printText(t('cli_help_examples_cmd', locale));
  printText(t('cli_help_mobile_profiles', locale));
  printText(t('cli_help_web_profiles', locale));
  printText(t('cli_help_run', locale));
  printText('');
  printText(t('cli_help_sec_pipelines', locale));
  printText(t('cli_help_preview', locale));
  printText(t('cli_help_schedule_list', locale));
  printText(t('cli_help_schedule_register_syntax', locale));
  printText(t('cli_help_schedule_register_desc', locale));
  printText(t('cli_help_schedule_remove', locale));
  printText('');
  printText(t('cli_help_sec_artifacts', locale));
  printText(t('cli_help_artifact', locale));
  printText(t('cli_help_open_artifact', locale));
  printText('');
  printText(t('cli_help_intent', locale));
  printText(t('cli_help_task_summary', locale));
  printText('');
  printText(t('cli_help_sec_offboarding', locale));
  printText(t('cli_help_offboard_summary', locale));
  printText('');
  printText(t('cli_help_sec_packets', locale));
  printText(t('cli_help_packet', locale));
  printText(t('cli_help_accept_next', locale));
  printText('');
  printText(t('cli_help_sec_approvals', locale));
  printText(t('cli_help_approvals', locale));
  printText(t('cli_help_approve', locale));
  printText(t('cli_help_reject', locale));
  printText('  pnpm kyberion project-trust request <pipeline-path>');
  printText('');
  printText(t('cli_help_sec_email', locale));
  printText(t('cli_help_email_summary', locale));
  printText(t('cli_help_email_status', locale));
  printText(t('cli_help_email_draft', locale));
  printText(t('cli_help_email_latest', locale));
  printText(t('cli_help_email_deliver', locale));
  printText(t('cli_help_email_archive', locale));
  printText(t('cli_help_calendar_summary', locale));
  printText(t('cli_help_calendar_status', locale));
  printText(t('cli_help_calendar_list', locale));
  printText(t('cli_help_calendar_agenda', locale));
  printText(t('cli_help_calendar_freebusy', locale));
  printText(t('cli_help_calendar_create', locale));
  printText('');
  printText(t('cli_help_examples', locale));
  printText('  pnpm kyberion list');
  printText('  pnpm kyberion search browser');
  printText('  pnpm kyberion run file-actuator -- --help');
  printText('  pnpm kyberion preview pipelines/verify-session.json');
  printText('  pnpm kyberion approvals');
  printText('  pnpm kyberion approve <request-id>');
  printText('  pnpm kyberion email status');
  printText('  pnpm kyberion email draft --triage-file active/shared/tmp/email-inbox-triage.md');
  printText('  pnpm kyberion calendar status');
  printText('  pnpm kyberion calendar list-calendars');
  printText('  pnpm kyberion calendar agenda --calendar-id primary --days 7');
  printText('  pnpm kyberion task plan "明日の会議資料とメール下書きを作って"');
  printText('  pnpm kyberion offboard tenant acme');
  printText('');
  printText(t('cli_help_first_run', locale));
  printText(t('cli_help_onboard', locale));
  printText(t('cli_help_doctor', locale));
  printText(t('cli_help_capabilities', locale));
  printText(t('cli_help_journal', locale));
  printText('');
  printText(`${t('cli_help_indexed_actuators', locale)} ${actuators.length}`);
}
