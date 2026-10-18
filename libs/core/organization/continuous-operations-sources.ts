/** Governed collectors. Source observations cannot select actions or authority. */
import * as path from 'node:path';
import type { DotCharter } from '../dot/dot-charter.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFileSnapshot, safeRealpath } from '../secure-io.js';
import { assertScopedCadenceExecution } from './organization-cadence.js';
import {
  listOrganizationDecisions,
  listOrganizationIncidents,
  listOrganizationServiceStates,
} from './organization-operating-model-management.js';
import { listOrganizationOperationStates } from './organization-operating-model-operations.js';
import {
  evaluateContinuousOperations,
  parseContinuousOperationsConfig,
  parseContinuousObservations,
  type ContinuousOperationsConfig,
  type ContinuousSourceSnapshot,
} from './continuous-operations-policy.js';

export interface ContinuousCollectionOptions {
  charter: DotCharter;
  now?: Date;
  rootDir?: string;
  apply?: boolean;
}
export interface ContinuousCollectionDeps {
  /** Completion clock for asynchronous collectors; tests may freeze it. */
  clock?: () => Date;
  authorize?: (config: ContinuousOperationsConfig, charter: DotCharter) => void;
  read?: (absolutePath: string) => unknown;
  metrics?: (config: ContinuousOperationsConfig, rootDir: string) => Record<string, number>;
  executePipeline?: (ref: string, charter: DotCharter) => Promise<void>;
}

export function assertContinuousOperationsCollectionAuthority(
  config: ContinuousOperationsConfig,
  charter: DotCharter
): void {
  if (
    charter.status !== 'active' ||
    charter.dot_id !== config.dot_id ||
    charter.scope.tier !== config.scope.tier ||
    charter.scope.tenant_slug !== config.scope.tenant_slug ||
    charter.scope.organization_id !== config.scope.organization_id ||
    charter.scope.project_id !== config.scope.project_id
  )
    throw new Error('Continuous source collection requires an active charter with exact scope');
  const role = assertScopedCadenceExecution('continuous source collection', {
    tier: config.scope.tier,
    tenantSlug: config.scope.tenant_slug,
    organizationId: config.scope.organization_id,
  });
  if (
    currentExecutionScope()?.organizationId !== config.scope.organization_id ||
    role !== charter.authority.authority_role
  )
    throw new Error(
      'Continuous source collection requires exact organization and charter authority'
    );
}

function organizationMetrics(
  config: ContinuousOperationsConfig,
  rootDir: string
): Record<string, number> {
  const query = {
    rootDir,
    tier: config.scope.tier,
    tenantSlug: config.scope.tenant_slug,
    organizationId: config.scope.organization_id,
  };
  return {
    overdue_operations: listOrganizationOperationStates(query).filter(
      (row) => row.due_status === 'overdue'
    ).length,
    open_incidents: listOrganizationIncidents(query).filter(
      (row) => row.status !== 'resolved' && row.status !== 'closed'
    ).length,
    pending_decisions: listOrganizationDecisions(query).filter(
      (row) => row.status === 'proposed' || row.status === 'pending_approval'
    ).length,
    unhealthy_services: listOrganizationServiceStates(query).filter(
      (row) => row.health === 'degraded' || row.health === 'critical'
    ).length,
  };
}

export async function collectContinuousOperationsSources(
  input: unknown,
  options: ContinuousCollectionOptions,
  deps: ContinuousCollectionDeps = {}
): Promise<ContinuousSourceSnapshot[]> {
  const config = parseContinuousOperationsConfig(input);
  // Authorization precedes even disabled source reads and collector callbacks.
  (deps.authorize ?? assertContinuousOperationsCollectionAuthority)(config, options.charter);
  if (!config.enabled) return [];
  const root = options.rootDir ?? pathResolver.rootDir();
  const now = options.now ?? new Date();
  const snapshots: ContinuousSourceSnapshot[] = [];
  let ranCollector = false;
  for (const source of config.sources) {
    if (source.kind === 'organization_metrics') {
      const metrics = (deps.metrics ?? organizationMetrics)(config, root);
      snapshots.push({
        source_id: source.source_id,
        observations: Object.entries(metrics).map(([metric, value]) => ({
          metric,
          value,
          observed_at: now.toISOString(),
          evidence_ref: `organization:${config.scope.organization_id}/metrics/${metric}`,
        })),
      });
      continue;
    }
    if (source.kind === 'pipeline') {
      if (!options.charter.authority.allowed_pipelines?.includes(source.pipeline_ref))
        throw new Error('Continuous collector pipeline is not permitted by the charter');
      if (options.apply) {
        if (!deps.executePipeline)
          throw new Error('Continuous collector pipeline executor is unavailable');
        await deps.executePipeline(source.pipeline_ref, options.charter);
        ranCollector = true;
      }
    }
    const sourcePath = path.join(root, source.path);
    if (!deps.read && safeRealpath(sourcePath) !== path.join(safeRealpath(root), source.path))
      throw new Error('Continuous source path must not traverse symlinks');
    const data = deps.read
      ? deps.read(sourcePath)
      : parseSafeJsonInput(
          safeReadFileSnapshot(sourcePath, 1_048_576).toString('utf8'),
          'continuous source'
        );
    // Preserve source timestamps: failed/stale collection must never freshen data.
    snapshots.push({
      source_id: source.source_id,
      observations: parseContinuousObservations(data),
    });
  }
  const evaluatedAt = ranCollector
    ? new Date(Math.max(now.getTime(), (deps.clock ?? (() => new Date()))().getTime()))
    : now;
  evaluateContinuousOperations(config, snapshots, evaluatedAt);
  return snapshots;
}
