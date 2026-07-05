#!/usr/bin/env node
import { formatNextAction, getGovernanceControlSummary } from '@agent/core';
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

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();

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
