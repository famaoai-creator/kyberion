/** Scoped internal-metric report executed only by the holder of a dot WorkItem lease. */
import { createHash } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { listDotCharters, type DotCharter } from '@agent/core/dot/dot-charter';
import { getWorkItem, listActiveWorkLeases } from '@agent/core/workforce/work-coordination';
import type { WorkItem, WorkLease } from '@agent/core/workforce/work-coordination-types';
import {
  writeScopedArtifact,
  type ScopedArtifactScope,
} from '@agent/core/workforce/artifact-store';
import {
  assertContinuousOperationsCollectionAuthority,
  collectContinuousOperationsSources,
} from '@agent/core/organization/continuous-operations-sources';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import { loadContinuousOperationsConfig } from './continuous_operations_config.js';

export const CONTINUOUS_OPERATIONS_REPORT_PIPELINE = 'pipelines/continuous-operations-report.json';
export interface ContinuousOperationsReportDeps {
  rootDir?: string;
  now?: () => Date;
  loadConfig?: typeof loadContinuousOperationsConfig;
  charters?: (rootDir: string) => DotCharter[];
  authorize?: typeof assertContinuousOperationsCollectionAuthority;
  getItem?: (id: string, rootDir: string) => WorkItem | null;
  leases?: () => WorkLease[];
  collect?: typeof collectContinuousOperationsSources;
  writeArtifact?: typeof writeScopedArtifact;
}
export interface ContinuousOperationsArtifactReport {
  artifact_ref: string;
  artifact_path: string;
  scope: ScopedArtifactScope;
  observation_count: number;
}
function required(context: Record<string, unknown>, key: string): string {
  const value = context[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error(`Report requires executor ${key}`);
  return value;
}
/** Typed context is checked against durable ownership, never accepted as authorization. */
function assertClaim(
  config: ContinuousOperationsConfig,
  charter: DotCharter,
  context: Record<string, unknown>,
  rootDir: string,
  deps: ContinuousOperationsReportDeps
): void {
  const dotId = required(context, 'dot_id');
  const itemId = required(context, 'work_item_id');
  const attemptId = required(context, 'attempt_id');
  const leaseId = required(context, 'lease_id');
  const actor = `dot:${charter.dot_id}`;
  if (dotId !== config.dot_id || dotId !== charter.dot_id)
    throw new Error('Report dot identity does not match its reviewed configuration');
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
    item.metadata.pipeline_ref !== CONTINUOUS_OPERATIONS_REPORT_PIPELINE ||
    item.metadata.requested_work_shape !== 'pipeline' ||
    item.metadata.continuous_work ||
    item.metadata.authority_role !== charter.authority.authority_role ||
    (item.context?.tenant_slug ?? '') !== (config.scope.tenant_slug ?? '') ||
    item.context?.organization_id !== config.scope.organization_id ||
    (item.context?.project_id ?? '') !== (config.scope.project_id ?? '')
  )
    throw new Error('Report requires an exact scoped in-progress executor claim');
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
    throw new Error('Report executor lease is inactive, expired or belongs to another actor');
}
const cell = (value: string): string => value.replace(/[|\r\n]/g, ' ');

export async function runContinuousOperationsReport(
  configRef: string,
  context: Record<string, unknown>,
  deps: ContinuousOperationsReportDeps = {}
): Promise<ContinuousOperationsArtifactReport> {
  const rootDir = deps.rootDir ?? pathResolver.rootDir();
  const config = (deps.loadConfig ?? loadContinuousOperationsConfig)(configRef, { rootDir });
  const activeCharter = () =>
    (deps.charters ?? ((root) => listDotCharters(root, { errors: [] }).map((row) => row.charter)))(
      rootDir
    ).find((row) => row.dot_id === config.dot_id && row.status === 'active');
  const charter = activeCharter();
  if (!charter) throw new Error('Report requires its configured active charter');
  (deps.authorize ?? assertContinuousOperationsCollectionAuthority)(config, charter);
  if (!config.enabled || config.sources.some((source) => source.kind !== 'organization_metrics'))
    throw new Error(
      'Scoped report requires an enabled configuration containing only organization_metrics sources'
    );
  if (
    !(charter.authority.allowed_work_shapes ?? []).includes('pipeline') ||
    !(charter.authority.allowed_pipelines ?? []).includes(CONTINUOUS_OPERATIONS_REPORT_PIPELINE)
  )
    throw new Error('Report pipeline is not permitted by the charter');
  assertClaim(config, charter, context, rootDir, deps);
  const now = (deps.now ?? (() => new Date()))();
  const snapshots = await (deps.collect ?? collectContinuousOperationsSources)(config, {
    charter,
    rootDir,
    now,
    apply: false,
  });
  const observations = snapshots.flatMap((snapshot) =>
    snapshot.observations.map((observation) => ({ source_id: snapshot.source_id, ...observation }))
  );
  const lines = [
    '# Continuous organization operations report',
    '',
    `Organization: ${cell(config.scope.organization_id)}`,
    `Tenant: ${cell(config.scope.tenant_slug ?? '(unbound)')}`,
    `Tier: ${config.scope.tier}`,
    `Observed at: ${now.toISOString()}`,
    '',
    '| Source | Metric | Count | Observed at | Evidence |',
    '| --- | --- | ---: | --- | --- |',
    ...observations.map(
      (row) =>
        `| ${cell(row.source_id)} | ${cell(row.metric)} | ${row.value} | ${cell(row.observed_at)} | ${cell(row.evidence_ref)} |`
    ),
    '',
    '## Objectives and inventory rules',
    '',
    ...config.rules.map(
      (rule) =>
        `- ${cell(rule.title)} (${cell(rule.objective_ref)}): ${cell(rule.metric)} ${rule.operator} ${rule.threshold}`
    ),
    '',
  ];
  // Collection can outlive the claim. Re-read both authority and ownership before publication.
  const currentCharter = activeCharter();
  if (
    !currentCharter ||
    !(currentCharter.authority.allowed_pipelines ?? []).includes(
      CONTINUOUS_OPERATIONS_REPORT_PIPELINE
    ) ||
    !(currentCharter.authority.allowed_work_shapes ?? []).includes('pipeline')
  )
    throw new Error('Report charter no longer authorizes this pipeline');
  (deps.authorize ?? assertContinuousOperationsCollectionAuthority)(config, currentCharter);
  assertClaim(config, currentCharter, context, rootDir, deps);
  const stamp = createHash('sha256')
    .update(
      JSON.stringify([config.scope, config.loop_id, context.work_item_id, context.attempt_id])
    )
    .digest('hex')
    .slice(0, 32);
  const scope: ScopedArtifactScope = {
    organization: config.scope.organization_id,
    ...(config.scope.tenant_slug ? { tenant: config.scope.tenant_slug } : {}),
    ...(config.scope.project_id ? { project: config.scope.project_id } : {}),
  };
  const written = (deps.writeArtifact ?? writeScopedArtifact)({
    scope,
    tier: config.scope.tier,
    artifact_class: 'report',
    name: `continuous-operations/reports/${stamp}.md`,
    content: lines.join('\n'),
    format: 'text',
    publish: {
      artifact_id: `ART-CONTOPS-${stamp.toUpperCase()}`,
      kind: 'report',
      organization_id: config.scope.organization_id,
      preview_text: `Organization operations metrics: ${observations.length} observations`,
      metadata: {
        loop_id: config.loop_id,
        work_item_id: context.work_item_id,
        attempt_id: context.attempt_id,
      },
    },
  });
  return {
    artifact_ref: written.artifact_id ?? written.repo_relative_path,
    artifact_path: written.repo_relative_path,
    scope,
    observation_count: observations.length,
  };
}
