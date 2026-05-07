/**
 * Environment bootstrap CLI.
 *
 * Loads an `EnvironmentManifest`, probes every capability, prints the
 * gap, and (with `--apply`) installs operator-confirmed capabilities
 * one by one, writing a setup-receipt that downstream commands check.
 *
 * Usage:
 *   pnpm env:bootstrap --manifest meeting-participation-runtime
 *     # ↑ dry run: probe + report only.
 *
 *   pnpm env:bootstrap --manifest meeting-participation-runtime --apply
 *     # ↑ install non-operator-confirmed capabilities (env vars, ...).
 *
 *   pnpm env:bootstrap --manifest meeting-participation-runtime --apply --force
 *     # ↑ also install operator-confirmed ones (brew install, npm add).
 */

import {
  bootstrapManifest,
  listEnvironmentManifestIds,
  loadEnvironmentManifest,
  logger,
  probeManifest,
  verifyReady,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';

// Register every probe so the manifest's `kind: 'probe'` entries
// resolve. This import is for side effects only.
import '@agent/core/environment-capability-probes';
import '@agent/core/blackhole-audio-bus';
import '@agent/core/pulse-audio-bus';

async function processManifest(
  manifestId: string,
  opts: {
    mission_id: string | undefined;
    apply: boolean;
    force_yes: boolean;
    verify: boolean;
    max_age_minutes: number;
  },
): Promise<{ ok: boolean; unsatisfied: number }> {
  const manifest = loadEnvironmentManifest(manifestId);

  if (opts.verify) {
    const report = verifyReady(manifest, {
      ...(opts.mission_id ? { mission_id: opts.mission_id } : {}),
      max_age_minutes: opts.max_age_minutes,
    });
    logger.info(JSON.stringify(report, null, 2));
    return { ok: report.ready, unsatisfied: report.missing.length };
  }

  if (!opts.apply) {
    const probes = await probeManifest(manifest, {
      ...(opts.mission_id ? { mission_id: opts.mission_id } : {}),
    });
    const summary = summarizeManifestDoctor(manifest, probes);
    for (const line of formatDoctorSummary(summary)) {
      logger.info(line);
    }
    const missing = probes.filter((p) => !p.satisfied).length;
    return { ok: missing === 0, unsatisfied: missing };
  }

  const receipt = await bootstrapManifest(manifest, {
    ...(opts.mission_id ? { mission_id: opts.mission_id } : {}),
    apply: true,
    force_yes: opts.force_yes,
  });
  logger.info(`📋 ${manifest.manifest_id} bootstrap receipt:`);
  logger.info(`   satisfied:    ${receipt.satisfied.length}`);
  logger.info(`   unsatisfied:  ${receipt.unsatisfied.length}`);
  logger.info(`   installs:     ${receipt.installs_performed.length}`);
  logger.info(`   expires_at:   ${receipt.expires_at}`);
  logger.info(`   manifest_fp:  ${receipt.manifest_fingerprint.slice(0, 12)}...`);
  logger.info(`   host_fp:      ${receipt.host_fingerprint.slice(0, 12)}...`);
  const receiptSummary = summarizeManifestDoctor(
    manifest,
    [...receipt.satisfied, ...receipt.unsatisfied],
  );
  for (const line of formatDoctorSummary(receiptSummary)) {
    logger.info(line);
  }
  return { ok: receipt.unsatisfied.length === 0, unsatisfied: receipt.unsatisfied.length };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('manifest', { type: 'string' })
    .option('all', { type: 'boolean', default: false })
    .option('list', { type: 'boolean', default: false })
    .option('mission', { type: 'string' })
    .option('apply', { type: 'boolean', default: false })
    .option('force', { type: 'boolean', default: false })
    .option('verify', { type: 'boolean', default: false })
    .option('max-age-minutes', { type: 'number', default: 60 * 24 * 7 })
    .parseSync();

  if (argv.list) {
    const ids = listEnvironmentManifestIds();
    logger.info(`📋 Environment manifests (${ids.length}):`);
    for (const id of ids) {
      try {
        const m = loadEnvironmentManifest(id);
        logger.info(`   - ${id}  (v${m.version}) — ${m.description ?? ''}`);
      } catch (err: any) {
        logger.warn(`   - ${id}  [load failed: ${err?.message ?? err}]`);
      }
    }
    return;
  }

  const missionId = argv.mission ? String(argv.mission) : undefined;
  if (missionId) process.env.MISSION_ID = missionId;

  const targetIds = argv.all
    ? listEnvironmentManifestIds()
    : argv.manifest
      ? [String(argv.manifest)]
      : [];
  if (targetIds.length === 0) {
    logger.error('Pass --manifest <id> or --all (and optionally --list).');
    process.exit(2);
  }

  let totalMissing = 0;
  for (const id of targetIds) {
    logger.info('');
    const result = await processManifest(id, {
      mission_id: missionId,
      apply: Boolean(argv.apply),
      force_yes: Boolean(argv.force),
      verify: Boolean(argv.verify),
      max_age_minutes: Number(argv['max-age-minutes']),
    });
    totalMissing += result.unsatisfied;
  }

  if (!argv.apply && !argv.verify) {
    logger.info('');
    logger.info('Pass --apply to install non-operator-confirmed capabilities.');
    logger.info('Pass --apply --force to also install operator-confirmed ones.');
    logger.info('Pass --all to bootstrap every manifest in the catalog at once.');
  }
  process.exit(totalMissing === 0 ? 0 : 1);
}

const isDirect = process.argv[1] && /bootstrap_environment\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runBootstrapEnvironment };
