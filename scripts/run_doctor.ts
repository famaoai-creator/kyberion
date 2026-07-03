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
  const meetingHint = needsMeetingHint
    ? ' or `pnpm env:bootstrap --manifest meeting-participation-runtime --apply` for meeting runtime gaps'
    : '';
  console.log(
    `Next step: run \`pnpm env:bootstrap --manifest <id> --apply\` for missing must/should items${meetingHint}.`
  );
  console.log(
    'Need to decide which surface to use after bootstrap? Run `pnpm setup:report --persona first-time-user`.'
  );
  const firstMissingSummary = report.summaries.find(
    (summary) => summary.counts.must + summary.counts.should > 0
  );
  if (firstMissingSummary) {
    const nextAction = buildNextAction({
      title: `Bootstrap ${firstMissingSummary.manifestId}`,
      reason: `Doctor reports ${firstMissingSummary.counts.must} must and ${firstMissingSummary.counts.should} should gaps.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: `pnpm env:bootstrap --manifest ${firstMissingSummary.manifestId} --apply`,
    });
    for (const line of formatNextAction(nextAction)) {
      console.log(line);
    }
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
