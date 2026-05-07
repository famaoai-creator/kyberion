#!/usr/bin/env node
import { listEnvironmentManifestIds, loadEnvironmentManifest, probeManifest } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

const DEFAULT_MANIFESTS = ['kyberion-runtime-baseline'];
const MISSION_MANIFESTS = ['kyberion-runtime-baseline', 'meeting-participation-runtime'];

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('manifest', { type: 'string' })
    .option('all', { type: 'boolean', default: false })
    .option('mission', { type: 'string' })
    .parseSync();

  const missionId = argv.mission ? String(argv.mission) : process.env.MISSION_ID || undefined;
  if (missionId) process.env.MISSION_ID = missionId;

  const manifestIds = argv.all
    ? listEnvironmentManifestIds()
    : argv.manifest
      ? [String(argv.manifest)]
      : missionId ? MISSION_MANIFESTS : DEFAULT_MANIFESTS;

  let totalMissing = 0;
  for (const manifestId of manifestIds) {
    const manifest = loadEnvironmentManifest(manifestId);
    const probes = await probeManifest(manifest, {
      ...(missionId ? { mission_id: missionId } : {}),
    });
    const summary = summarizeManifestDoctor(manifest, probes);
    for (const line of formatDoctorSummary(summary)) {
      console.log(line);
    }
    totalMissing += probes.filter((probe) => !probe.satisfied).length;
    console.log('');
  }

  if (totalMissing === 0) {
    console.log('All required capabilities are satisfied.');
    process.exit(0);
  }

  if (!missionId && !argv.manifest && !argv.all) {
    console.log('Tip: pass `--mission <id>` to include mission-scoped meeting checks such as voice consent.');
  }
  console.log('Next step: run `pnpm env:bootstrap --manifest <id> --apply` for missing must/should items.');
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
