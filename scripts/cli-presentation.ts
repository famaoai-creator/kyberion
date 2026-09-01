import * as path from 'node:path';
import chalk from 'chalk';
import { resolveLocale as resolveUnifiedLocale, type SupportedLocale } from '@agent/core/locale';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { t as coreT } from '@agent/core/t';
import type { VocabularyKey } from '@agent/core/t';

const rootDir = pathResolver.rootDir();

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
    process.stderr.write(
      chalk.red(`\n${t('cli_error_branch_not_found').replace('{branch}', branchId)}\n`)
    );
    return;
  }

  process.stderr.write(
    chalk.magenta(`\n🎭 PERSONA SWAP: Loading latent wisdom from branch "${branchId}"\n`)
  );
}

export function printHeader(locale = resolveLocale()) {
  console.log(chalk.yellow('\n🌌 KYBERION CONSOLE v2.2 [SECURE-IO ENFORCED]'));
  console.log(chalk.gray(t('cli_header_tagline', locale) + '\n'));
}

export function printHelp(actuators: { length: number }, locale = resolveLocale()) {
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
  console.log(t('cli_help_schedule_register_syntax', locale));
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
  console.log(t('cli_help_sec_offboarding', locale));
  console.log(t('cli_help_offboard_summary', locale));
  console.log('');
  console.log(t('cli_help_sec_packets', locale));
  console.log(t('cli_help_packet', locale));
  console.log(t('cli_help_accept_next', locale));
  console.log('');
  console.log(t('cli_help_sec_approvals', locale));
  console.log(t('cli_help_approvals', locale));
  console.log(t('cli_help_approve', locale));
  console.log(t('cli_help_reject', locale));
  console.log('  pnpm kyberion project-trust request <pipeline-path>');
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
  console.log('  pnpm kyberion list');
  console.log('  pnpm kyberion search browser');
  console.log('  pnpm kyberion run file-actuator -- --help');
  console.log('  pnpm kyberion preview pipelines/verify-session.json');
  console.log('  pnpm kyberion approvals');
  console.log('  pnpm kyberion approve <request-id>');
  console.log('  pnpm kyberion email status');
  console.log('  pnpm kyberion email draft --triage-file active/shared/tmp/email-inbox-triage.md');
  console.log('  pnpm kyberion calendar status');
  console.log('  pnpm kyberion calendar list-calendars');
  console.log('  pnpm kyberion calendar agenda --calendar-id primary --days 7');
  console.log('  pnpm kyberion task plan "明日の会議資料とメール下書きを作って"');
  console.log('  pnpm kyberion offboard tenant acme');
  console.log('');
  console.log(t('cli_help_first_run', locale));
  console.log(t('cli_help_onboard', locale));
  console.log(t('cli_help_doctor', locale));
  console.log(t('cli_help_capabilities', locale));
  console.log(t('cli_help_journal', locale));
  console.log('');
  console.log(`${t('cli_help_indexed_actuators', locale)} ${actuators.length}`);
}
