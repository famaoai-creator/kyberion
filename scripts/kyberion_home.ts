#!/usr/bin/env node
import { formatNextAction, getGovernanceControlSummary } from '@agent/core';
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
  type NotificationChannelTarget,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { collectOperatorHomeSummary } from '@agent/core';
import { collectDoctorReport } from './run_doctor.js';

const COMMANDS = [
  ['mission create', 'Create or issue a mission'],
  ['meeting:preflight', 'Prepare meeting inputs'],
  ['pipeline campaign-suite', 'Run a pipeline campaign'],
  ['dashboard', 'Open the sovereign dashboard'],
  ['doctor', 'Inspect health and readiness'],
  ['backup', 'Create or inspect backups'],
  ['inbox', 'Open the operator inbox'],
  ['notification set', 'Configure operator notifications'],
  ['cli', 'Run the surface-aware CLI'],
  ['help', 'Show command guidance'],
] as const;

// E2E-04 Task 2: `pnpm kyberion notify --set slack:C012345` writes the
// operator's default notification channel (surface:target).
function handleNotifySubcommand(setValue: string): void {
  const [surface, ...rest] = setValue.split(':');
  const target = rest.join(':');
  const allowed = ['slack', 'imessage', 'telegram', 'discord'];
  if (!allowed.includes(surface) || !target) {
    console.error(`Usage: pnpm kyberion notify --set <${allowed.join('|')}>:<channel-id>`);
    process.exitCode = 1;
    return;
  }
  const prefs = loadNotificationPreferences();
  prefs.default_channel = { surface, target } as NotificationChannelTarget;
  const filePath = saveNotificationPreferences(prefs);
  console.log(`Default notification channel set to ${surface}:${target} (${filePath})`);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .option('set', { type: 'string', description: 'notify: set default channel surface:target' })
    .parseSync();

  const subcommand = String(argv._[0] || '');
  if (subcommand === 'notify') {
    if (argv.set) {
      handleNotifySubcommand(String(argv.set));
    } else {
      console.log(JSON.stringify(loadNotificationPreferences(), null, 2));
    }
    return;
  }

  const doctor = await collectDoctorReport({});
  const governance = getGovernanceControlSummary();
  const home = collectOperatorHomeSummary({ limit: 8 });

  if (argv.json) {
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

  console.log('Kyberion Home');
  console.log(`Doctor gaps: ${doctor.totalMissing}`);
  console.log(`Governance pending approvals: ${governance.pending_approvals}`);
  console.log(`Clarification questions: ${home.counts.clarificationQuestions}`);
  console.log(`Active missions: ${home.counts.activeMissions}`);
  console.log(`Inbox unread: ${home.counts.unreadInbox}`);
  console.log(`Home status: ${home.statusLabel} — ${home.statusDetail}`);
  console.log('');
  for (const line of formatNextAction(home.nextAction)) {
    console.log(line);
  }
  console.log('');
  for (const [command, description] of COMMANDS) {
    console.log(`- ${command}: ${description}`);
  }
}

void main();
