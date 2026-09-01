import { listCustomerChannelBindings } from '@agent/core/customer-channel-binding';
import { collectDoctorReport } from './run_doctor.js';
import { loadCliManifest } from './check_cli_manifest.js';
import { getGovernanceControlSummary } from '@agent/core/governance-status';
import { formatNextAction } from '@agent/core/next-action';
import { collectOperatorHomeSummary } from '@agent/core/operator-home-summary';
import type { VocabularyKey } from '@agent/core/t';

export type HomeUi = (key: VocabularyKey, params?: Record<string, string | number>) => string;

export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm kyberion', 'i18n:recorder:recorder_help_home'],
  ['pnpm kyberion ask "<request>"', 'i18n:recorder:recorder_help_ask'],
  ['pnpm kyberion intent "<intent>"', 'i18n:recorder:recorder_help_intent'],
  ['pnpm kyberion procedure list', 'i18n:recorder:recorder_help_procedure_list'],
  ['pnpm kyberion procedure inspect <id>', 'i18n:recorder:recorder_help_procedure_inspect'],
  ['pnpm kyberion procedure repair <id>', 'i18n:recorder:recorder_help_procedure_repair'],
  [
    'pnpm kyberion procedure promote <id> --substrate desktop --recording <path> --intent "..."',
    'i18n:recorder:recorder_help_procedure_promote',
  ],
  [
    "pnpm kyberion procedure run <id> --inputs '{}' [--cdp-port <port>] [--record-video]",
    'i18n:recorder:recorder_help_procedure_run',
  ],
  [
    'pnpm kyberion feedback <intent-id> --outcome dissatisfied --correction "..."',
    'i18n:recorder:recorder_help_feedback',
  ],
  ['pnpm kyberion improvements', 'i18n:recorder:recorder_help_improvements'],
  ['pnpm kyberion record desktop [--duration <sec>]', 'i18n:recorder:recorder_help_record_desktop'],
  ['pnpm kyberion recording inspect <path>', 'i18n:recorder:recorder_help_recording_inspect'],
  [
    'pnpm kyberion recording review <path> --approve-recording --approve-intent',
    'i18n:recorder:recorder_help_recording_review',
  ],
  ['pnpm kyberion inbox [--read <id>|--accept <id>]', 'i18n:recorder:recorder_help_inbox'],
  ['pnpm kyberion inbox --read-all [--match <text>]', 'i18n:recorder:recorder_help_inbox_all'],
  ['pnpm kyberion approvals [--approve <id>|--deny <id>]', 'i18n:recorder:recorder_help_approvals'],
  ['pnpm kyberion notify [--set slack:<channel>]', 'i18n:recorder:recorder_help_notify'],
  ['pnpm kyberion deals [--requirements <deal-id>]', 'i18n:recorder:recorder_help_deals'],
  [
    'pnpm kyberion deals --ingest-audio <deal-id> --audio <path>',
    'i18n:recorder:recorder_help_deals_audio',
  ],
  ['pnpm kyberion doctor', 'i18n:recorder:recorder_help_doctor'],
] as const;

export function printCommands(ui: HomeUi): void {
  console.log(ui('recorder:recorder_commands_header'));
  for (const [command, description] of COMMANDS) {
    const rendered = description.startsWith('i18n:')
      ? ui(description.slice('i18n:'.length) as VocabularyKey)
      : description;
    console.log(`  ${command.padEnd(52)} ${rendered}`);
  }
  const registry = loadCliManifest();
  const registryCommands = registry.commands.filter((command) => command.audience === 'user');
  console.log('');
  console.log('  Registered user commands:');
  for (const command of registryCommands) {
    const label = command.command ? `pnpm kyberion ${command.command}` : 'pnpm kyberion';
    console.log(`  ${label.padEnd(52)} ${command.noun} ${command.verb}`);
  }
}
function printCustomerBindingsWarning(ui: HomeUi): void {
  try {
    const bindings = listCustomerChannelBindings().filter(
      (entry) => entry.binding.active !== false
    );
    if (bindings.length === 0) return;
    console.log('');
    console.log(ui('recorder:recorder_customer_binding_warning', { count: bindings.length }));
    for (const entry of bindings.slice(0, 5)) {
      console.log(
        `  - ${entry.binding.surface}:${entry.binding.channel_id} → ${entry.tenantSlug}` +
          (entry.binding.counterpart?.org ? ` (${entry.binding.counterpart.org})` : '')
      );
    }
    if (bindings.length > 5)
      console.log(ui('recorder:recorder_customer_binding_more', { count: bindings.length - 5 }));
  } catch {
    // home must never fail on an optional panel
  }
}

export async function showHome(ui: HomeUi, json: boolean): Promise<void> {
  const doctor = await collectDoctorReport({});
  const governance = getGovernanceControlSummary();
  const home = collectOperatorHomeSummary({ limit: 8 });

  if (json) {
    console.log(
      JSON.stringify(
        {
          doctor,
          governance,
          home,
          commands: COMMANDS.map(([command, description]) => ({ command, description })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(ui('recorder:recorder_home_title'));
  console.log(
    ui('recorder:recorder_home_status', { label: home.statusLabel, detail: home.statusDetail })
  );
  console.log(ui('recorder:recorder_home_doctor', { count: doctor.totalMissing }));
  console.log(
    ui('recorder:recorder_home_counts', {
      approvals: governance.pending_approvals,
      questions: home.counts.clarificationQuestions,
      inbox: home.counts.unreadInbox,
    })
  );
  const recent = [...home.activeMissions]
    .sort((left, right) =>
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    )
    .slice(0, 3);
  console.log(
    ui('recorder:recorder_home_missions', {
      active: home.counts.activeMissions,
      recent: home.counts.recentlyActiveMissions,
      suffix: recent.length > 0 ? ' — recent:' : '',
    })
  );
  for (const mission of recent) {
    console.log(
      `  - ${mission.missionId} [${mission.missionType || 'mission'}] ${String(mission.goalSummary || '').slice(0, 70)}`
    );
  }
  console.log('');
  for (const line of formatNextAction(home.nextAction)) {
    console.log(line);
  }
  printCustomerBindingsWarning(ui);
  console.log('');
  printCommands(ui);
}
