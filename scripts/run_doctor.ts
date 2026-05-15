#!/usr/bin/env node
import { listEnvironmentManifestIds, loadEnvironmentManifest, probeManifest } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

const DEFAULT_MANIFESTS = ['kyberion-runtime-baseline', 'reasoning-backend'];
const MISSION_MANIFESTS = ['kyberion-runtime-baseline', 'reasoning-backend', 'meeting-participation-runtime'];
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
        : missionId ? MISSION_MANIFESTS : DEFAULT_MANIFESTS;

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

  return { totalMissing, summaries };
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

  if (report.totalMissing === 0) {
    console.log('All required capabilities are satisfied.');
    process.exit(0);
  }

  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (!missionId && !argv.manifest && !argv.runtime && !argv.all) {
    console.log('Tip: pass `--runtime meeting --mission <id>` to include browser, voice, audio, and mission-scoped consent checks.');
  }
  console.log('Next step: run `pnpm env:bootstrap --manifest <id> --apply` for missing must/should items, or `pnpm env:bootstrap --manifest meeting-participation-runtime --apply` for meeting runtime gaps.');
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
