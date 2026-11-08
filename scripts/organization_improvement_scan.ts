/**
 * organization_improvement_scan.ts — `core:organization_improvement_scan` op.
 *
 * Discovery half of the purpose-driven improvement loop: runs the deterministic
 * scan and, under a verified dot executor claim (`apply: true`), publishes the
 * report as a scoped artifact. Read-only mode (CLI, manual pipeline run)
 * returns the report without writing — the scan proposes, it never applies.
 *
 * CLI:  node scripts/organization_improvement_scan.ts --org <id> [--tenant <slug>]
 *        [--tier confidential] [--window-days 30] [--json]
 */
import { createHash } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { listDotCharters, type DotCharter } from '@agent/core/dot/dot-charter';
import { getWorkItem, listActiveWorkLeases } from '@agent/core/workforce/work-coordination';
import type { WorkItem, WorkLease } from '@agent/core/workforce/work-coordination-types';
import {
  writeScopedArtifact,
  type ScopedArtifactScope,
} from '@agent/core/workforce/artifact-store';
import { logger } from '@agent/core/core';
import {
  runOrganizationImprovementScan,
  type OrganizationImprovementScanReport,
} from '@agent/core/organization/organization-improvement-scan';
import type { OrganizationTier } from '@agent/core/organization/organization-operating-model';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

export const ORGANIZATION_IMPROVEMENT_SCAN_PIPELINE =
  'pipelines/organization-improvement-scan.json';
const TIERS: OrganizationTier[] = ['personal', 'confidential', 'public'];

export interface ImprovementScanScopeInput {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  windowDays?: number;
  maxCandidates?: number;
}

export interface OrganizationImprovementScanDeps {
  rootDir?: string;
  now?: () => Date;
  charters?: (rootDir: string) => DotCharter[];
  getItem?: (id: string, rootDir: string) => WorkItem | null;
  leases?: () => WorkLease[];
  writeArtifact?: typeof writeScopedArtifact;
  scan?: typeof runOrganizationImprovementScan;
}

export interface OrganizationImprovementScanResult {
  report: OrganizationImprovementScanReport;
  artifact_ref?: string;
  artifact_path?: string;
  applied: boolean;
}

function required(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error(`Improvement scan apply requires executor ${key}`);
  return value;
}

/** Typed context is checked against durable ownership, never accepted as authorization. */
function assertClaim(
  input: ImprovementScanScopeInput,
  charter: DotCharter,
  context: Record<string, unknown>,
  rootDir: string,
  deps: OrganizationImprovementScanDeps
): void {
  const dotId = required(context, 'dot_id');
  const itemId = required(context, 'work_item_id');
  const attemptId = required(context, 'attempt_id');
  const leaseId = required(context, 'lease_id');
  const actor = `dot:${charter.dot_id}`;
  if (dotId !== charter.dot_id)
    throw new Error('Scan dot identity does not match the claiming dot');
  const item = (deps.getItem ?? ((id, root) => getWorkItem(id, { rootDir: root })))(
    itemId,
    rootDir
  );
  if (
    !item ||
    item.status !== 'in_progress' ||
    item.lease_id !== leaseId ||
    item.current_attempt_id !== attemptId ||
    item.claimed_by_peer_id !== actor ||
    item.metadata?.dot_id !== dotId ||
    item.metadata.pipeline_ref !== ORGANIZATION_IMPROVEMENT_SCAN_PIPELINE ||
    item.metadata.requested_work_shape !== 'pipeline' ||
    item.metadata.authority_role !== charter.authority.authority_role ||
    (item.context?.tenant_slug ?? '') !== (input.tenantSlug ?? '') ||
    (item.context?.organization_id ?? '') !== input.organizationId ||
    (item.context?.project_id ?? '') !== ((context.project_id as string | undefined) ?? '')
  )
    throw new Error('Improvement scan apply requires an exact scoped in-progress executor claim');
  const lease = (deps.leases ?? listActiveWorkLeases)().find((row) => row.lease_id === leaseId);
  const at = (deps.now ?? (() => new Date()))().getTime();
  if (
    !lease ||
    lease.status !== 'active' ||
    lease.item_id !== itemId ||
    lease.holder_peer_id !== actor ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    Date.parse(lease.expires_at) <= at
  )
    throw new Error('Improvement scan executor lease is inactive, expired or another actor');
}

/**
 * Runs the scan. `apply` publishes the report through the governed artifact
 * store and therefore requires the scoped executor claim; without it the
 * report is returned to the caller only.
 */
export async function runOrganizationImprovementScanOp(
  input: ImprovementScanScopeInput,
  context: Record<string, unknown> = {},
  deps: OrganizationImprovementScanDeps = {},
  options: { apply?: boolean } = {}
): Promise<OrganizationImprovementScanResult> {
  const rootDir = deps.rootDir ?? pathResolver.rootDir();
  const report = (deps.scan ?? runOrganizationImprovementScan)(input, {
    rootDir,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!options.apply) return { report, applied: false };

  const charters = (
    deps.charters ?? ((root) => listDotCharters(root, { errors: [] }).map((l) => l.charter))
  )(rootDir);
  const dotId = required(context, 'dot_id');
  const charter = charters.find(
    (row) =>
      row.dot_id === dotId &&
      row.status === 'active' &&
      row.scope.organization_id === input.organizationId &&
      row.scope.tier === input.tier &&
      (row.scope.tenant_slug ?? undefined) === (input.tenantSlug ?? undefined)
  );
  if (!charter) throw new Error('Improvement scan apply requires an active scoped charter');
  if (
    !(charter.authority.allowed_work_shapes ?? []).includes('pipeline') ||
    !(charter.authority.allowed_pipelines ?? []).includes(ORGANIZATION_IMPROVEMENT_SCAN_PIPELINE)
  )
    throw new Error('Improvement scan pipeline is not permitted by the charter');
  assertClaim(input, charter, context, rootDir, deps);

  const stamp = createHash('sha256')
    .update(
      JSON.stringify([
        input.organizationId,
        context.work_item_id,
        context.attempt_id,
        report.report_id,
      ])
    )
    .digest('hex')
    .slice(0, 32);
  const scope: ScopedArtifactScope = {
    organization: input.organizationId,
    ...(input.tenantSlug ? { tenant: input.tenantSlug } : {}),
  };
  const written = (deps.writeArtifact ?? writeScopedArtifact)({
    scope,
    tier: input.tier,
    artifact_class: 'report',
    name: `improvement-scan/${stamp}.json`,
    content: JSON.stringify(report, null, 2),
    format: 'json',
    publish: {
      artifact_id: `ART-IMPROVESCAN-${stamp.toUpperCase()}`,
      kind: 'report',
      organization_id: input.organizationId,
      preview_text: `Improvement scan: ${report.candidates.length} candidates, cost ${report.cost.current.cost_usd} USD/${report.cost.current.llm_calls} calls in ${report.window_days}d`,
      metadata: {
        work_item_id: context.work_item_id,
        attempt_id: context.attempt_id,
        report_id: report.report_id,
      },
    },
  });
  return {
    report,
    artifact_ref: written.artifact_id ?? written.repo_relative_path,
    artifact_path: written.repo_relative_path,
    applied: true,
  };
}

function summarize(report: OrganizationImprovementScanReport): string {
  const lines = [
    `# Improvement scan — ${report.scope.organization_id}`,
    `generated_at: ${report.generated_at} (window ${report.window_days}d)`,
    `objectives: ${report.objectives.length}${report.purpose_missing ? ' (purpose missing)' : ''}`,
    `cost(${report.window_days}d): ${report.cost.current.cost_usd} USD / ${report.cost.current.llm_calls} calls / ${report.cost.current.llm_tokens} tokens, unknown-evidence ${report.cost.current.unknown_cost_calls}`,
    `top models: ${report.cost.top_models.map((m) => `${m.model} ${m.share_pct.toFixed(0)}%`).join(', ') || 'none'}`,
    `operations: ${Object.entries(report.operations)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    `outcomes: +${report.outcomes.improved} / ~${report.outcomes.no_change} / -${report.outcomes.regressed} / ?${report.outcomes.unmeasurable} across ${report.outcomes.dots_observed} dots`,
    '',
    `## Candidates (${report.candidates.length})`,
    ...report.candidates.map(
      (c) =>
        `- [${c.priority_score.toFixed(2)}] (${c.rule_id}/${c.target_kind}) ${c.title} — ${c.summary}`
    ),
  ];
  return lines.join('\n');
}

export const runImprovementScanScript = defineScript({
  name: 'organization:improvement-scan',
  flags: ['json'],
  async run(context) {
    const argv = createStandardYargs(['node', 'organization_improvement_scan.ts', ...context.argv])
      .option('org', { type: 'string', demandOption: true, describe: 'organization_id' })
      .option('tenant', { type: 'string', describe: 'tenant slug' })
      .option('tier', { type: 'string', choices: TIERS, default: 'confidential' })
      .option('window-days', { type: 'number', default: 7 })
      .option('max-candidates', { type: 'number', default: 20 })
      .option('root', { type: 'string', describe: 'checkout root override' })
      .parseSync();
    const result = await runOrganizationImprovementScanOp(
      {
        organizationId: String(argv.org),
        tier: argv.tier as OrganizationTier,
        ...(argv.tenant ? { tenantSlug: String(argv.tenant) } : {}),
        windowDays: Number(argv['window-days']),
        maxCandidates: Number(argv['max-candidates']),
      },
      {},
      argv.root ? { rootDir: String(argv.root) } : {}
    );
    context.print(context.json ? result.report : summarize(result.report));
    return result.report;
  },
});

if (
  isDirectScript(import.meta.url, 'organization_improvement_scan.ts') ||
  isDirectScript(import.meta.url, 'organization_improvement_scan.js')
)
  void runImprovementScanScript().catch((error) => {
    logger.error(`improvement-scan failed — ${String(error)}`);
    process.exitCode = 1;
  });
