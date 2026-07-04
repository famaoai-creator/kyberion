#!/usr/bin/env node
import {
  listEnvironmentManifestIds,
  listScheduledPipelines,
  loadEnvironmentManifest,
  getGovernanceControlSummary,
  probeManifest,
} from '@agent/core';
import { buildNextAction, formatNextAction } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { summarizeBackupStatus } from './backup.js';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

const DEFAULT_MANIFESTS = ['kyberion-runtime-baseline', 'reasoning-backend'];
const MISSION_MANIFESTS = [
  'kyberion-runtime-baseline',
  'reasoning-backend',
  'meeting-participation-runtime',
];
const RUNTIME_PRESETS: Record<string, string[]> = {
  meeting: ['meeting-participation-runtime'],
  voice: ['meeting-participation-runtime'],
  browser: ['meeting-participation-runtime'],
  baseline: DEFAULT_MANIFESTS,
};

export interface DoctorRunReport {
  totalMissing: number;
  summaries: Array<{
    manifestId: string;
    lines: string[];
    counts: { must: number; should: number; nice: number };
  }>;
  scheduleLines: string[];
  governanceLines: string[];
  backupLines: string[];
}

export function collectPipelineScheduleDoctorLines(): string[] {
  const schedules = listScheduledPipelines().sort((a, b) => a.id.localeCompare(b.id));
  const lines = [`Pipeline schedules: ${schedules.length} registered`];
  if (schedules.length === 0) {
    lines.push(
      '  - none registered; start `node dist/scripts/chronos_daemon.js` to sync scheduled pipeline ADFs'
    );
    return lines;
  }
  for (const schedule of schedules.slice(0, 8)) {
    const trigger =
      schedule.trigger.type === 'cron'
        ? `${schedule.trigger.cron}${schedule.trigger.timezone ? ` ${schedule.trigger.timezone}` : ''}`
        : `${schedule.trigger.intervalMs ?? 0}ms`;
    lines.push(
      `  - ${schedule.id}: ${schedule.enabled ? 'enabled' : 'disabled'}; ${trigger}; last=${schedule.lastRun ?? 'never'}; status=${schedule.lastStatus ?? 'unknown'}`
    );
  }
  if (schedules.length > 8) lines.push(`  - ... ${schedules.length - 8} more`);
  return lines;
}

export function collectBackupDoctorLines(): string[] {
  const status = summarizeBackupStatus();
  if (status.status === 'missing') {
    return [
      'Backup status: missing; run `KYBERION_BACKUP_PASSPHRASE=... pnpm backup create --scope all --encrypt`',
    ];
  }
  const age = status.latestAgeHours?.toFixed(1) ?? 'unknown';
  return [
    `Backup status: ${status.status}; latest=${status.latestName}; age=${age}h; archives=${status.count}; dir=${status.backupDir}`,
  ];
}

function isReasoningBackendSummary(summary: DoctorRunReport['summaries'][number]): boolean {
  return (
    summary.manifestId === 'reasoning-backend' ||
    summary.lines.some((line) => line.includes('reasoning-backend.any-real'))
  );
}

function formatMissingCapabilityNextStep(
  firstMissingSummary: DoctorRunReport['summaries'][number]
): { message: string; title: string; reason: string; command: string } {
  if (isReasoningBackendSummary(firstMissingSummary)) {
    return {
      message:
        'Next step: run `pnpm reasoning:setup`. Configure one real backend: Codex/Gemini/AGY CLI auth, `ANTHROPIC_API_KEY`, `KYBERION_NEMOTRON_URL`, or `KYBERION_LOCAL_LLM_URL`. Use `KYBERION_REASONING_BACKEND=stub` only for explicit offline test mode.',
      title: 'Configure reasoning backend',
      reason: `Doctor reports ${firstMissingSummary.counts.must} must and ${firstMissingSummary.counts.should} should reasoning backend gaps.`,
      command: 'pnpm reasoning:setup',
    };
  }
  return {
    message: `Next step: run \`pnpm env:bootstrap --manifest ${firstMissingSummary.manifestId} --apply\` for missing must/should items.`,
    title: `Bootstrap ${firstMissingSummary.manifestId}`,
    reason: `Doctor reports ${firstMissingSummary.counts.must} must and ${firstMissingSummary.counts.should} should gaps.`,
    command: `pnpm env:bootstrap --manifest ${firstMissingSummary.manifestId} --apply`,
  };
}

export async function collectDoctorReport(argv: {
  manifest?: string;
  runtime?: string;
  all?: boolean;
  mission?: string;
}): Promise<DoctorRunReport> {
  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (missionId) process.env.MISSION_ID = missionId;

  const manifestIds = argv.all
    ? listEnvironmentManifestIds()
    : argv.manifest
      ? [String(argv.manifest)]
      : argv.runtime
        ? (RUNTIME_PRESETS[String(argv.runtime)] ?? [String(argv.runtime)])
        : missionId
          ? MISSION_MANIFESTS
          : DEFAULT_MANIFESTS;

  const summaries: DoctorRunReport['summaries'] = [];
  let totalMissing = 0;

  for (const manifestId of manifestIds) {
    const manifest = loadEnvironmentManifest(manifestId);
    const probes = await probeManifest(manifest, {
      ...(missionId ? { mission_id: missionId } : {}),
    });
    const summary = summarizeManifestDoctor(manifest, probes);
    const lines = formatDoctorSummary(summary);
    summaries.push({ manifestId, lines, counts: summary.counts });
    totalMissing += summary.counts.must + summary.counts.should;
  }

  const governance = getGovernanceControlSummary();
  const governanceLines = [
    `Governance controls: kill_switch=${governance.kill_switch_monitoring ? 'armed' : 'idle'}; pending_approvals=${governance.pending_approvals}; approval_rules=${governance.approval_rules}; shell_rules=${governance.shell_allow_rules}/${governance.shell_deny_rules}; egress_mode=${governance.egress_mode}; egress_domains=${governance.egress_allowlist_domains}`,
  ];

  return {
    totalMissing,
    summaries,
    scheduleLines: collectPipelineScheduleDoctorLines(),
    governanceLines,
    backupLines: collectBackupDoctorLines(),
  };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('manifest', { type: 'string' })
    .option('runtime', {
      type: 'string',
      describe: 'Runtime preset to inspect: meeting, voice, browser, or baseline',
    })
    .option('all', { type: 'boolean', default: false })
    .option('mission', { type: 'string' })
    .parseSync();

  const report = await collectDoctorReport(argv);

  for (const summary of report.summaries) {
    for (const line of summary.lines) {
      console.log(line);
    }
    console.log('');
  }
  for (const line of report.scheduleLines) {
    console.log(line);
  }
  for (const line of report.governanceLines) {
    console.log(line);
  }
  for (const line of report.backupLines) {
    console.log(line);
  }
  console.log('');

  if (report.totalMissing === 0) {
    console.log('All required capabilities are satisfied.');
    if (!argv.manifest && !argv.runtime && !argv.all) {
      console.log(
        'Want the right surface next? Run `pnpm setup:report --persona first-time-user` for a recommended surface guide.'
      );
    }
    process.exit(0);
  }

  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (!missionId && !argv.manifest && !argv.runtime && !argv.all) {
    console.log(
      'Tip: pass `--runtime meeting --mission <id>` to include browser, voice, audio, and mission-scoped consent checks.'
    );
  }
  const needsMeetingHint =
    argv.mission ||
    (argv.runtime && ['meeting', 'voice', 'browser'].includes(String(argv.runtime)));
  const firstMissingSummary = report.summaries.find(
    (summary) => summary.counts.must + summary.counts.should > 0
  );
  if (firstMissingSummary) {
    const nextStep = formatMissingCapabilityNextStep(firstMissingSummary);
    console.log(
      needsMeetingHint && !isReasoningBackendSummary(firstMissingSummary)
        ? `${nextStep.message} For meeting runtime gaps, use \`pnpm env:bootstrap --manifest meeting-participation-runtime --apply\`.`
        : nextStep.message
    );
    console.log(
      'Need to decide which surface to use after bootstrap? Run `pnpm setup:report --persona first-time-user`.'
    );
    const nextAction = buildNextAction({
      title: nextStep.title,
      reason: nextStep.reason,
      next_action_type: isReasoningBackendSummary(firstMissingSummary)
        ? 'run_command'
        : 'bootstrap_environment',
      suggested_command: nextStep.command,
    });
    for (const line of formatNextAction(nextAction)) {
      console.log(line);
    }
  } else {
    console.log('Next step: inspect doctor findings above and rerun the relevant setup command.');
    console.log(
      'Need to decide which surface to use after bootstrap? Run `pnpm setup:report --persona first-time-user`.'
    );
  }
  process.exit(1);
}

const isDirect = process.argv[1] && /run_doctor\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runDoctor };
