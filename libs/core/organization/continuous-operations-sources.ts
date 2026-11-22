/** Governed collectors. Source observations cannot select actions or authority. */
import * as path from 'node:path';
import { dotStatePath } from '../dot/dot-state-paths.js';
import type { DotCharter } from '../dot/dot-charter.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { currentScopeEnvelope, runtimeScopeIdentity } from '../scope-envelope.js';
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
  parseCollectorObservations,
  validateContinuousSourceSnapshot,
  type ContinuousOperationsSource,
  type ContinuousOperationsConfig,
  type ContinuousSourceSnapshot,
} from './continuous-operations-policy.js';
import { organizationCostMetrics } from './organization-cost-metrics.js';
import { observePipelineScheduleDependencies } from './recurring-work-observation.js';
export { observePipelineScheduleDependencies } from './recurring-work-observation.js';

export interface ContinuousCollectionOptions {
  charter: DotCharter;
  now?: Date;
  rootDir?: string;
  apply?: boolean;
  withheldSources?: Set<string>;
}
export interface ContinuousCollectionDeps {
  /** Completion clock for asynchronous collectors; tests may freeze it. */
  clock?: () => Date;
  authorize?: (config: ContinuousOperationsConfig, charter: DotCharter) => void;
  read?: (absolutePath: string) => unknown;
  metrics?: (config: ContinuousOperationsConfig, rootDir: string) => Record<string, number>;
  schedules?: typeof observePipelineScheduleDependencies;
  executePipeline?: (
    ref: string,
    charter: DotCharter,
    capture: (attemptId: string) => void
  ) => Promise<void>;
  readPipeline?: (
    ref: string,
    charter: DotCharter,
    capture: (attemptId: string) => void
  ) => Promise<void>;
  pipelineHeld?: (ref: string) => boolean;
  isPipelineUnavailable?: (error: unknown) => boolean;
}

/** Every file observation for a personal loop must come from its charter owner's namespace. */
export function assertContinuousObservationPaths(
  config: ContinuousOperationsConfig,
  charter: Pick<DotCharter, 'scope'>
): void {
  if (config.scope.tier !== 'personal') return;
  const prefix = dotStatePath(charter, 'continuous-operations', 'snapshots') + '/';
  for (const source of config.sources) {
    if ('path' in source && !source.path.startsWith(prefix))
      throw new Error('Continuous observation path must belong to the current personal owner');
  }
}

function matchesContinuousCharterScope(
  config: ContinuousOperationsConfig,
  charter: DotCharter
): boolean {
  return (
    charter.dot_id === config.dot_id &&
    charter.scope.tier === config.scope.tier &&
    charter.scope.tenant_slug === config.scope.tenant_slug &&
    charter.scope.organization_id === config.scope.organization_id &&
    charter.scope.project_id === config.scope.project_id
  );
}

function boundContinuousRole(config: ContinuousOperationsConfig, purpose: string): string {
  const role = assertScopedCadenceExecution(purpose, {
    tier: config.scope.tier,
    tenantSlug: config.scope.tenant_slug,
    organizationId: config.scope.organization_id,
  });
  if (currentExecutionScope()?.organizationId !== config.scope.organization_id)
    throw new Error(`Continuous ${purpose} requires exact organization authority`);
  return role;
}

export function assertContinuousOperationsCollectionAuthority(
  config: ContinuousOperationsConfig,
  charter: DotCharter
): void {
  if (charter.status !== 'active' || !matchesContinuousCharterScope(config, charter))
    throw new Error('Continuous source collection requires an active charter with exact scope');
  if (boundContinuousRole(config, 'source collection') !== charter.authority.authority_role)
    throw new Error(
      'Continuous source collection requires exact organization and charter authority'
    );
}

export function assertContinuousOperationsReconciliationAuthority(
  config: ContinuousOperationsConfig,
  charter: DotCharter
): void {
  if (
    !matchesContinuousCharterScope(config, charter) ||
    boundContinuousRole(config, 'collector reconciliation') !== 'organization_operator'
  )
    throw new Error(
      'Collector reconciliation requires an organization operator with exact charter scope'
    );
  const owner = (currentScopeEnvelope()?.identity ?? runtimeScopeIdentity()).nhi_id;
  if (
    charter.scope.tier === 'personal' &&
    (!charter.scope.owner_nhi || charter.scope.owner_nhi !== owner)
  )
    throw new Error('Collector reconciliation requires the personal charter owner');
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
  const cost = organizationCostMetrics(
    {
      organizationId: config.scope.organization_id,
      tenantSlug: config.scope.tenant_slug,
      tier: config.scope.tier,
    },
    7
  );
  const operationStates = listOrganizationOperationStates(query).filter(
    (row) =>
      row.organization_id === query.organizationId &&
      row.tier === query.tier &&
      row.tenant_slug === query.tenantSlug
  );
  return {
    overdue_operations: operationStates.filter((row) => row.due_status === 'overdue').length,
    failing_operations: operationStates.filter((row) => row.status === 'failed').length,
    blocked_operations: operationStates.filter((row) => row.status === 'blocked').length,
    open_incidents: listOrganizationIncidents(query).filter(
      (row) => row.status !== 'resolved' && row.status !== 'closed'
    ).length,
    pending_decisions: listOrganizationDecisions(query).filter(
      (row) => row.status === 'proposed' || row.status === 'pending_approval'
    ).length,
    unhealthy_services: listOrganizationServiceStates(query).filter(
      (row) => row.health === 'degraded' || row.health === 'critical'
    ).length,
    cost_usd_7d: cost.cost_usd,
    llm_tokens_7d: cost.llm_tokens,
    llm_calls_7d: cost.llm_calls,
    unknown_cost_calls_7d: cost.unknown_cost_calls,
    // Completeness context: a possibly-partial total must not read as truth.
    cost_evidence_complete_7d: cost.cost_complete ? 1 : 0,
    cost_withheld_partitions_7d: cost.withheld_partitions,
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
  assertContinuousObservationPaths(config, options.charter);
  const root = options.rootDir ?? pathResolver.rootDir();
  const start = options.now ?? new Date();
  const readSnapshot = (
    source: Extract<ContinuousOperationsSource, { path: string }>,
    attemptId?: string
  ) => {
    const sourcePath = path.join(root, source.path);
    if (!deps.read && safeRealpath(sourcePath) !== path.join(safeRealpath(root), source.path))
      throw new Error('Continuous source path must not traverse symlinks');
    const data = deps.read
      ? deps.read(sourcePath)
      : parseSafeJsonInput(
          safeReadFileSnapshot(sourcePath, 1_048_576).toString('utf8'),
          'continuous source'
        );
    return {
      source_id: source.source_id,
      observations: attemptId
        ? parseCollectorObservations(data, attemptId)
        : parseContinuousObservations(data),
    };
  };
  const pipelineSources = new Map<
    string,
    Array<Extract<ContinuousOperationsSource, { kind: 'pipeline' }>>
  >();
  for (const source of config.sources) {
    if (source.kind !== 'pipeline') continue;
    const group = pipelineSources.get(source.pipeline_ref) ?? [];
    group.push(source);
    pipelineSources.set(source.pipeline_ref, group);
  }
  const captured = new Map<string, ContinuousSourceSnapshot>();
  let attemptedCollector = false;
  for (const [ref, group] of pipelineSources) {
    const withhold = () => {
      for (const source of group) options.withheldSources?.add(source.source_id);
    };
    if (options.withheldSources && deps.pipelineHeld?.(ref)) {
      withhold();
      continue;
    }
    if (!options.charter.authority.allowed_pipelines?.includes(ref))
      throw new Error('Continuous collector pipeline is not permitted by the charter');
    let capturedUnderFence = false;
    const capture = (attemptId?: string) => {
      for (const source of group) {
        try {
          captured.set(source.source_id, readSnapshot(source, attemptId));
        } catch (error) {
          if (!options.withheldSources) throw error;
          options.withheldSources.add(source.source_id);
        }
      }
      capturedUnderFence = true;
    };
    const access = options.apply ? deps.executePipeline : deps.readPipeline;
    if (options.apply && !access)
      throw new Error('Continuous collector pipeline executor is unavailable');
    if (access) {
      attemptedCollector ||= options.apply === true;
      try {
        await access(ref, options.charter, capture);
      } catch (error) {
        if (!options.withheldSources || !deps.isPipelineUnavailable?.(error)) throw error;
        withhold();
        continue;
      }
    }
    if (!capturedUnderFence) capture();
  }
  // Sample direct metrics after effects settle so a slow collector cannot age them in memory.
  const now = attemptedCollector
    ? new Date(Math.max(start.getTime(), (deps.clock ?? (() => new Date()))().getTime()))
    : start;
  const snapshots: ContinuousSourceSnapshot[] = [];
  const scheduleRefs = config.sources.flatMap((source) =>
    source.kind === 'pipeline_schedule_health' ? [source.pipeline_ref] : []
  );
  const schedulesByRef = new Map<string, ReturnType<typeof observePipelineScheduleDependencies>>();
  if (scheduleRefs.length) {
    const rows = (deps.schedules ?? observePipelineScheduleDependencies)(
      config.scope,
      scheduleRefs,
      { rootDir: root, now }
    );
    for (const row of rows) {
      if (!schedulesByRef.has(row.pipeline_ref)) schedulesByRef.set(row.pipeline_ref, []);
      schedulesByRef.get(row.pipeline_ref)!.push(row);
    }
  }
  for (const source of config.sources) {
    if (source.kind === 'pipeline_schedule_health') {
      const rows = schedulesByRef.get(source.pipeline_ref) ?? [];
      const metrics = {
        registered_pipeline_schedules: rows.length,
        failing_pipeline_schedules: rows.filter((row) => row.status === 'failing').length,
        due_pipeline_schedules: rows.filter((row) => row.timing_due).length,
        unconfirmed_due_pipeline_schedules: rows.filter((row) => row.potentially_due).length,
      };
      snapshots.push({
        source_id: source.source_id,
        observations: Object.entries(metrics).map(([metric, value]) => ({
          metric,
          value,
          observed_at: now.toISOString(),
          evidence_ref: `schedule-registry:${source.pipeline_ref}/${metric}`,
        })),
      });
      continue;
    }
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
    if (options.withheldSources?.has(source.source_id)) continue;
    if (source.kind === 'pipeline') {
      const snapshot = captured.get(source.source_id)!;
      try {
        validateContinuousSourceSnapshot(config, source, snapshot, now);
        snapshots.push(snapshot);
      } catch (error) {
        if (!options.withheldSources) throw error;
        options.withheldSources.add(source.source_id);
      }
      continue;
    }
    snapshots.push(readSnapshot(source));
  }
  evaluateContinuousOperations(config, snapshots, now, options.withheldSources);
  return snapshots;
}
