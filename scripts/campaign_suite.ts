/**
 * E2E-02 Task 6: campaign suite executor.
 *
 * Reads a campaign brief, plans deliverables through the pure planner in
 * @agent/core (design resolved exactly once per surface), executes each
 * deliverable via the owning actuator CLI, and writes campaign-manifest.json
 * with the design fingerprint. Per-deliverable failures are recorded, never
 * fatal to the rest of the campaign.
 */
import * as path from 'node:path';
import {
  buildCampaignPlan,
  logger,
  pathResolver,
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  sharedTmp,
  type CampaignBrief,
  type CampaignManifest,
  type CampaignPlanEntry,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

function executeEntry(entry: CampaignPlanEntry): { ok: boolean; detail?: string } {
  const inputPath = sharedTmp(
    path.join('campaign-suite', `${entry.kind}-${Date.now().toString(36)}.json`)
  );
  safeWriteFile(inputPath, JSON.stringify(entry.action_input, null, 2));
  const cliPath = `dist/libs/actuators/${entry.actuator}/src/index.js`;
  const result = safeExecResult('node', [cliPath, '--input', inputPath], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 300_000,
  });
  if (result.status !== 0) {
    const stderrTail = String(result.stderr || '')
      .trim()
      .split('\n')
      .slice(-5)
      .join(' | ');
    return { ok: false, detail: stderrTail || `exit ${result.status}` };
  }
  return { ok: true };
}

export function runCampaignSuite(options: {
  briefPath: string;
  outputRoot?: string;
  dryRun?: boolean;
}): CampaignManifest {
  const briefRaw = safeReadFile(pathResolver.rootResolve(options.briefPath), {
    encoding: 'utf8',
  }) as string;
  const brief = JSON.parse(briefRaw) as CampaignBrief;
  if (brief.kind !== 'campaign-brief' || !Array.isArray(brief.deliverables)) {
    throw new Error(
      `Invalid campaign brief at ${options.briefPath}: expected kind=campaign-brief with deliverables[]`
    );
  }

  const outputRoot =
    options.outputRoot ||
    `active/shared/exports/campaigns/${brief.title.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 48)}`;
  const plan = buildCampaignPlan(brief, { outputRoot });

  const manifest: CampaignManifest = { ...plan.manifest, deliverables: [] };
  for (const entry of plan.entries) {
    safeMkdir(pathResolver.rootResolve(entry.output_dir), { recursive: true });
    if (options.dryRun) {
      manifest.deliverables.push({
        kind: entry.kind,
        output_dir: entry.output_dir,
        status: 'skipped',
        detail: 'dry_run',
      });
      continue;
    }
    const outcome = executeEntry(entry);
    manifest.deliverables.push({
      kind: entry.kind,
      output_dir: entry.output_dir,
      status: outcome.ok ? 'succeeded' : 'failed',
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    });
    logger.info(
      `[campaign-suite] ${entry.kind}: ${outcome.ok ? 'succeeded' : `failed (${outcome.detail})`}`
    );
  }

  const manifestPath = pathResolver.rootResolve(path.join(outputRoot, 'campaign-manifest.json'));
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  logger.info(`[campaign-suite] manifest: ${manifestPath} (design=${manifest.primary_hex})`);
  return manifest;
}

async function main(): Promise<void> {
  const argv = createStandardYargs()
    .option('brief', {
      type: 'string',
      demandOption: true,
      describe: 'Path to campaign-brief JSON',
    })
    .option('output-root', { type: 'string' })
    .option('dry-run', { type: 'boolean', default: false })
    .parseSync();

  const manifest = runCampaignSuite({
    briefPath: String(argv.brief),
    outputRoot: argv['output-root'] ? String(argv['output-root']) : undefined,
    dryRun: Boolean(argv['dry-run']),
  });
  const failed = manifest.deliverables.filter((entry) => entry.status === 'failed');
  process.exit(failed.length > 0 ? 1 : 0);
}

const isDirect = process.argv[1] && /campaign_suite\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
