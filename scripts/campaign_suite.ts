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
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  buildCampaignPlan,
  loadCampaignBriefAtPath,
  validateCampaignManifest,
  type CampaignManifest,
  type CampaignPlanEntry,
} from '@agent/core/campaign-suite';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { pathResolver, sharedTmp } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';

function resolveCampaignPath(value: unknown, label: string, allowMissingLeaf = false): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

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
  // Actuator CLIs exit 0 even when the pipeline reports failed steps —
  // trusting the exit code alone produced "succeeded" manifests with empty
  // output dirs (字面成功). Check the reported status AND the actual outcome.
  const stdout = String(result.stdout || '');
  const failedMatch = stdout.match(/"status":\s*"failed"[\s\S]*?"error":\s*"([^"]+)"/);
  if (failedMatch) {
    return { ok: false, detail: failedMatch[1] };
  }
  const outputDirAbs = resolveCampaignPath(entry.output_dir, 'campaign output directory');
  const produced = safeExistsSync(outputDirAbs) ? safeReaddir(outputDirAbs) : [];
  if (produced.length === 0) {
    return { ok: false, detail: 'no artifacts produced in output_dir' };
  }
  return { ok: true };
}

export function runCampaignSuite(options: {
  briefPath: string;
  outputRoot?: string;
  dryRun?: boolean;
}): CampaignManifest {
  const briefPath = resolveCampaignPath(options.briefPath, 'brief path');
  if (!safeLstat(briefPath).isFile()) {
    throw new Error(`brief path must be a regular file: ${options.briefPath}`);
  }
  const brief = loadCampaignBriefAtPath(briefPath);

  const outputRootPath =
    options.outputRoot ||
    `active/shared/exports/campaigns/${brief.title.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 48)}`;
  const outputRoot = pathResolver.toRepoRelative(
    resolveCampaignPath(outputRootPath, 'output root', true)
  );
  const plan = buildCampaignPlan(brief, { outputRoot });

  const manifest: CampaignManifest = { ...plan.manifest, deliverables: [] };
  for (const entry of plan.entries) {
    safeMkdir(resolveCampaignPath(entry.output_dir, 'campaign output directory', true), {
      recursive: true,
    });
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

  const manifestPath = resolveCampaignPath(
    path.join(outputRoot, 'campaign-manifest.json'),
    'campaign manifest path',
    true
  );
  const validatedManifest = validateCampaignManifest(manifest, manifestPath);
  safeWriteFile(manifestPath, JSON.stringify(validatedManifest, null, 2));
  logger.info(
    `[campaign-suite] manifest: ${manifestPath} (design=${validatedManifest.primary_hex})`
  );
  return validatedManifest;
}

async function main(args: string[] = []): Promise<number> {
  const argv = createStandardYargs(['node', 'campaign_suite', ...args])
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
  return failed.length > 0 ? 1 : 0;
}

if (
  isDirectScript(import.meta.url, 'campaign_suite.ts') ||
  isDirectScript(import.meta.url, 'campaign_suite.js')
) {
  void defineScript({
    name: 'campaign:suite',
    flags: [],
    async run(context) {
      const status = await main(context.argv);
      if (status !== 0) throw new Error(`campaign:suite failed with exit code ${status}`);
    },
  })();
}
