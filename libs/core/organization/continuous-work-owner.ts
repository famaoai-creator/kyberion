/** Governed continuous managed work owner. */
import * as path from 'node:path';
import { restoreDotWorkItemBody } from '../dot/dot-work-item.js';
import { safeExistsSync, safeReadFileSnapshot, safeWriteFile } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import { withLock } from '../foundation/lock-utils.js';
import { isOperationsHalted } from '../governance/operations-halt.js';
import { organizationCadenceLifecycle } from './organization-cadence.js';
class OrganizationCadenceHeld extends Error {}
import { dotBudgetHardThrottled } from '../dot/dot-budget.js';
import { dotDailyTokenCapReached } from '../dot/dot-runtime.js';
import { findDotCharter, resolveDotDelegationLimit, type DotCharter } from '../dot/dot-charter.js';
import { withExecutionContext } from '../authority.js';
import { assertProjectObjectiveLinks } from '../project/project-objective-links.js';
import { normalizeWorkItemContext } from '../workforce/work-coordination-identity.js';
import {
  getWorkItem,
  listWorkItems,
  claimWorkItem,
  renewWorkItemLease,
  releaseWorkItem,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import {
  CONTINUOUS_MANAGED_WORK_PIPELINE,
  parseContinuousWorkPlan,
  isProjectWorkPlan,
} from './continuous-work-plan.js';
import {
  authorize,
  authorizeItem,
  continuousWorkCheckpoint,
  continuousWorkRuntimePath,
  ContinuousOwnerPreEffectError,
  digest,
  validateState,
  type OwnerState,
  type ContinuousWorkOwnerScope,
  type ContinuousWorkOwnerPorts,
  type ContinuousWorkOwnerOptions,
  type ContinuousWorkOwnerDeps,
  type ContinuousWorkOwnerRow,
} from './continuous-work-owner-state.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
export * from './continuous-work-owner-state.js';

type SweepPosition = Pick<WorkItem, 'created_at' | 'item_id'>;

function compareSweepPosition(a: SweepPosition, b: SweepPosition): number {
  return a.created_at.localeCompare(b.created_at) || a.item_id.localeCompare(b.item_id);
}

function readSweepPosition(value: unknown): SweepPosition | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const position = value as Partial<SweepPosition>;
  return typeof position.created_at === 'string' && typeof position.item_id === 'string'
    ? { created_at: position.created_at, item_id: position.item_id }
    : undefined;
}

/** One bounded sweep; checkpoints persist before every possible external effect. */
export async function runContinuousWorkOwner(
  charter: DotCharter,
  ports: ContinuousWorkOwnerPorts,
  options: ContinuousWorkOwnerOptions = {},
  deps: ContinuousWorkOwnerDeps = {}
): Promise<ContinuousWorkOwnerRow[]> {
  (deps.authorize ?? authorize)(charter);
  const expectedScope = normalizeWorkItemContext(charter.scope);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  // The halt API's historical rootDir option is an exact flag-file override.
  const halted =
    deps.halted ??
    (() =>
      isOperationsHalted({
        rootDir: path.join(rootDir, 'active/shared/runtime/governance/operations-halt.json'),
      }));
  if (!charter.scope.organization_id)
    throw new Error('Continuous owner requires organization scope');
  if (
    charter.status !== 'active' ||
    !(charter.authority.allowed_execution_shapes ?? ['direct_reply']).includes('pipeline')
  )
    return [];
  if (!(charter.authority.allowed_pipelines ?? []).includes(CONTINUOUS_MANAGED_WORK_PIPELINE))
    return [];
  if (
    halted() ||
    (
      deps.throttled ??
      ((c) => dotBudgetHardThrottled(c, { rootDir }) || dotDailyTokenCapReached(c, { rootDir }))
    )(charter)
  )
    return [];
  const scope: ContinuousWorkOwnerScope = {
    tier: charter.scope.tier,
    ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
    organization_id: charter.scope.organization_id,
  };
  const organizationActive =
    deps.organizationActive ??
    (() =>
      organizationCadenceLifecycle(
        {
          organizationId: scope.organization_id,
          tenantSlug: scope.tenant_slug,
          tier: scope.tier,
        },
        rootDir
      ) === 'active');
  if (!organizationActive()) return [];
  const actor = `dot:${charter.dot_id}`;
  const deadline = Date.now() + (charter.goal?.budget?.wall_clock_ms_per_wake ?? 60_000);
  const read =
    deps.read ??
    ((file: string) =>
      safeExistsSync(file)
        ? parseSafeJsonInput(
            safeReadFileSnapshot(file, 4 * 1024 * 1024).toString('utf8'),
            'continuous work owner checkpoint'
          )
        : undefined);
  const write =
    deps.write ??
    ((file: string, value: unknown) => safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`));
  const lock = deps.lock ?? withLock;
  const cap = Math.max(
    0,
    Math.min(
      Math.floor(options.limit ?? 1),
      resolveDotDelegationLimit(charter.authority.max_concurrent_delegations)
    )
  );
  if (!(cap > 0)) return [];
  const eligible = (item: WorkItem): boolean =>
    (!options.itemId || item.item_id === options.itemId) &&
    Boolean(item.metadata?.continuous_work) &&
    item.metadata?.dot_id === charter.dot_id &&
    item.metadata?.pipeline_ref === CONTINUOUS_MANAGED_WORK_PIPELINE &&
    (item.context?.tenant_slug ?? '') === (scope.tenant_slug ?? '') &&
    item.context?.organization_id === scope.organization_id &&
    item.context?.project_id === expectedScope.project_id &&
    (item.status === 'ready' ||
      (item.status === 'in_progress' &&
        item.claimed_by_peer_id === actor &&
        Boolean(item.lease_id)));
  const candidates = (
    deps.list ?? (() => listWorkItems({ status: ['ready', 'in_progress'] }, { rootDir }))
  )()
    .filter(eligible)
    .sort(compareSweepPosition);
  const cursorPath =
    candidates.length > 1
      ? continuousWorkRuntimePath(charter, 'sweep-position.json', rootDir)
      : undefined;
  const considered = new Set<string>();
  const rows: ContinuousWorkOwnerRow[] = [];
  for (let index = 0; index < Math.min(cap, candidates.length); index += 1) {
    if (halted() || !organizationActive() || Date.now() >= deadline) break;
    // Advance only for the next attempted candidate, including approval and preflight waits.
    // Admission and effect ownership are checked separately under the per-item lock.
    const selected = cursorPath
      ? await lock(`continuous-owner-sweep-${digest(cursorPath)}`, async () => {
          const position = readSweepPosition(read(cursorPath));
          const remaining = candidates.filter((item) => !considered.has(item.item_id));
          const next =
            (position && remaining.find((item) => compareSweepPosition(item, position) > 0)) ||
            remaining[0];
          if (next) write(cursorPath, { item_id: next.item_id, created_at: next.created_at });
          return next;
        })
      : candidates[0];
    if (!selected) break;
    considered.add(selected.item_id);
    const row = await lock(
      `continuous-owner-${digest([rootDir, selected.item_id])}`,
      async (): Promise<ContinuousWorkOwnerRow> => {
        const item = (deps.get ?? ((id) => getWorkItem(id, { rootDir })))(selected.item_id);
        if (!item || !eligible(item)) return { work_item_id: selected.item_id, status: 'skipped' };
        const base = { work_item_id: item.item_id };
        let state: OwnerState | undefined;
        let statePath: string | undefined;
        let leaseId: string | undefined;
        try {
          (deps.authorizeItem ?? authorizeItem)(charter, item, rootDir);
          const plan = parseContinuousWorkPlan(
            restoreDotWorkItemBody(charter, item, rootDir).metadata?.continuous_work
          );
          const actionRef = item.metadata?.action_ref;
          if (
            typeof actionRef !== 'string' ||
            !actionRef ||
            item.metadata?.decision !== 'approve' ||
            !item.metadata.approval_request_id
          )
            throw new Error('Managed owner requires an admitted human-approved action');
          if (item.context?.project_id !== expectedScope.project_id)
            throw new Error('Managed owner project context mismatch');
          const checkpoint = continuousWorkCheckpoint(charter, actionRef, plan, rootDir);
          const { ids, identity } = checkpoint;
          const stored = read(checkpoint.statePath);
          const checkpointState: OwnerState =
            stored === undefined
              ? {
                  version: 1,
                  identity,
                  project_id: ids.project_id,
                  project_created: !isProjectWorkPlan(plan),
                  missions: Object.fromEntries(
                    plan.missions.map((m) => [
                      m.key,
                      {
                        mission_id: ids.mission_ids[m.key]!,
                        created: false,
                        status: 'pending_approval' as const,
                        evidence_refs: [],
                      },
                    ])
                  ),
                  step: 0,
                }
              : validateState(stored, identity, ids);
          if (
            !checkpointState.project_created &&
            !checkpointState.intent &&
            !checkpointState.error &&
            plan.project?.objective_ids?.length
          ) {
            assertProjectObjectiveLinks(
              { ...scope, project_id: ids.project_id, objective_ids: plan.project.objective_ids },
              rootDir
            );
          }
          statePath = checkpoint.statePath;
          state = checkpointState;
          let projectRecovered = false;
          if (state.intent || state.error) {
            if (
              state.intent === 'ensure-project' &&
              !state.project_created &&
              plan.project &&
              ports.verifyCreatedProject?.({
                ...plan.project,
                project_id: ids.project_id,
                scope,
                operation_key: `${actionRef}:project`,
              })
            ) {
              projectRecovered = true;
            } else {
              throw new Error(
                state.error ??
                  `Uncertain owner operation '${state.intent}'; verify effects before resuming`
              );
            }
          }
          const ttlMs = options.leaseTtlMs ?? 3_600_000;
          if (item.status === 'in_progress') {
            if (!item.lease_id || item.claimed_by_peer_id !== actor)
              throw new Error('Managed work is owned by another executor or has lost its lease');
            (deps.renew ?? renewWorkItemLease)({
              leaseId: item.lease_id,
              actorPeerId: actor,
              ttlMs,
            });
            leaseId = item.lease_id;
          } else {
            leaseId = (deps.claim ?? claimWorkItem)({
              itemId: item.item_id,
              actorPeerId: actor,
              purpose: 'continuous managed owner',
              ttlMs,
              expectedVersion: item.version,
              idempotencyKey: `continuous-owner:${actionRef}`,
              requireNewLease: true,
            }).lease.lease_id;
          }
          if (projectRecovered) {
            state = {
              ...state,
              project_created: true,
              step: state.step + 1,
              intent: undefined,
              error: undefined,
            };
          }
          write(statePath, state);
          if (state.completed) {
            (deps.release ?? releaseWorkItem)({
              itemId: item.item_id,
              leaseId,
              actorPeerId: actor,
              nextStatus: 'done',
              effectDisposition: 'completed',
              summary: 'Recovered completed continuous managed work',
            });
            return {
              ...base,
              project_id: state.project_id,
              state_path: statePath,
              status: 'completed',
              missions: state.missions,
            };
          }
          const abort = new AbortController();
          const assertCurrent = (): void =>
            withExecutionContext(
              charter.authority.authority_role,
              () => {
                const current = (
                  deps.currentCharter ?? ((c, root) => findDotCharter(c.dot_id, root)?.charter)
                )(charter, rootDir);
                if (
                  !current ||
                  current.status !== 'active' ||
                  digest(current.scope) !== digest(charter.scope) ||
                  current.authority.authority_role !== charter.authority.authority_role ||
                  !current.authority.allowed_execution_shapes?.includes('pipeline') ||
                  !current.authority.allowed_pipelines?.includes(CONTINUOUS_MANAGED_WORK_PIPELINE)
                )
                  throw new Error('Managed owner charter changed or became inactive');
                (deps.authorize ?? authorize)(current);
                if (halted()) throw new Error('Operations halted before managed effect');
                if (!organizationActive())
                  throw new OrganizationCadenceHeld('Organization inactive before managed effect');
                if (abort.signal.aborted || Date.now() >= deadline)
                  throw new Error('Continuous owner wall-clock budget exhausted before effect');
                const latest = (deps.get ?? ((id) => getWorkItem(id, { rootDir })))(item.item_id);
                if (
                  !latest ||
                  latest.status !== 'in_progress' ||
                  latest.lease_id !== leaseId ||
                  latest.claimed_by_peer_id !== actor
                )
                  throw new Error('Owner lease changed before effect');
                (deps.authorizeItem ?? authorizeItem)(current, latest, rootDir);
                // A renewal immediately before each effect prevents a lapsed owner from replaying.
                (deps.renew ?? renewWorkItemLease)({
                  leaseId: leaseId!,
                  actorPeerId: actor,
                  ttlMs,
                });
              },
              undefined,
              charter.scope.tenant_slug,
              charter.scope.organization_id
            );
          const effect = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
            assertCurrent();
            state!.intent = operation;
            write(statePath!, state);
            let timer: ReturnType<typeof setTimeout> | undefined;
            let result: T;
            try {
              result = await Promise.race([
                fn(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => {
                      abort.abort();
                      reject(
                        new Error('Continuous owner deadline exceeded; effect outcome uncertain')
                      );
                    },
                    Math.max(1, deadline - Date.now())
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            assertCurrent();
            state!.intent = undefined;
            state!.step += 1;
            return result;
          };
          if (!state.project_created) {
            const result = await effect('ensure-project', () =>
              ports.ensureProject({
                assertCurrent,
                ...plan.project!,
                project_id: ids.project_id,
                scope,
                operation_key: `${actionRef}:project`,
                signal: abort.signal,
              })
            );
            if (result.project_id !== ids.project_id)
              throw new Error('Project port returned a different target');
            state.project_created = true;
            write(statePath, state);
          }
          // Ensure every mission exists before advancing dependencies. Failed prerequisites never cancel existing work.
          for (const m of plan.missions) {
            const current = state.missions[m.key]!;
            if (!current.created) {
              const result = await effect(`ensure-mission:${m.key}`, () =>
                ports.ensureMission({
                  assertCurrent,
                  ...m,
                  mission_id: current.mission_id,
                  project_id: ids.project_id,
                  prerequisites: (m.depends_on ?? []).map((key) => ids.mission_ids[key]!),
                  scope,
                  operation_key: `${actionRef}:mission:${m.key}`,
                  signal: abort.signal,
                })
              );
              if (result.mission_id !== current.mission_id)
                throw new Error('Mission port returned a different target');
              current.created = true;
              write(statePath, state);
            }
          }
          for (const m of plan.missions) {
            const current = state.missions[m.key]!;
            if (current.status === 'completed' || current.status === 'failed') continue;
            if ((m.depends_on ?? []).some((key) => state!.missions[key]!.status !== 'completed'))
              continue;
            const result = await effect(`advance-mission:${m.key}:${state.step}`, () =>
              ports.advanceMission({
                assertCurrent,
                mission_id: current.mission_id,
                project_id: ids.project_id,
                scope,
                operation_key: `${actionRef}:advance:${m.key}:${state!.step}`,
                creation_key: `${actionRef}:mission:${m.key}`,
                ...(m.development ? { development: m.development } : {}),
                signal: abort.signal,
              })
            );
            if (
              !['pending_approval', 'running', 'completed', 'blocked', 'failed'].includes(
                result.status
              ) ||
              !Array.isArray(result.evidence_refs)
            )
              throw new Error('Invalid mission progress result');
            Object.assign(current, result);
            write(statePath, state);
          }
          const missions = Object.values(state.missions);
          state.completed = missions.every((m) => m.status === 'completed');
          write(statePath, state);
          const status = state.completed
            ? 'completed'
            : missions.some((m) => m.status === 'failed')
              ? 'failed'
              : missions.some((m) => m.status === 'blocked')
                ? 'blocked'
                : missions.some((m) => m.status === 'running')
                  ? 'running'
                  : 'pending_approval';
          if (state.completed)
            (deps.release ?? releaseWorkItem)({
              itemId: item.item_id,
              leaseId,
              actorPeerId: actor,
              nextStatus: 'done',
              effectDisposition: 'completed',
              summary: `Continuous managed work completed: ${ids.project_id}`,
            });
          else if (status === 'failed' || status === 'blocked')
            (deps.release ?? releaseWorkItem)({
              itemId: item.item_id,
              leaseId,
              actorPeerId: actor,
              nextStatus: 'blocked',
              summary: `Managed child requires intervention: ${status}`,
            });
          return {
            ...base,
            project_id: ids.project_id,
            state_path: statePath,
            status,
            missions: state.missions,
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (error instanceof OrganizationCadenceHeld && !state?.intent)
            return { ...base, status: 'skipped', reason };
          const preEffect = error instanceof ContinuousOwnerPreEffectError;
          const noManagedEffects = preEffect && state?.step === 0;
          if (state && statePath) {
            if (preEffect) state.intent = undefined;
            state.error = reason;
            write(statePath, state);
          }
          // Invalid/expired approval may fail before checkpoint assignment. Still quarantine
          // this actor's exact scoped claim so it cannot monopolize every later sweep.
          const latest = (deps.get ?? ((id) => getWorkItem(id, { rootDir })))(item.item_id);
          if (
            latest?.claimed_by_peer_id === actor &&
            latest.status === 'in_progress' &&
            latest.metadata?.dot_id === charter.dot_id &&
            latest.metadata.pipeline_ref === CONTINUOUS_MANAGED_WORK_PIPELINE &&
            digest([
              latest.context?.tenant_slug ?? '',
              latest.context?.organization_id,
              latest.context?.project_id ?? '',
            ]) ===
              digest([scope.tenant_slug ?? '', scope.organization_id, expectedScope.project_id])
          ) {
            try {
              (deps.release ?? releaseWorkItem)({
                itemId: item.item_id,
                leaseId: latest.lease_id!,
                actorPeerId: actor,
                ...(noManagedEffects
                  ? {
                      nextStatus: 'archived' as const,
                      effectDisposition: 'pre_effect' as const,
                      metadata: { dot_executor: { reason_code: 'pre_effect_failure' } },
                    }
                  : { nextStatus: 'blocked' as const }),
                summary: reason,
              });
            } catch {
              (deps.update ?? updateWorkItem)({
                itemId: latest.item_id,
                expectedVersion: latest.version,
                status: 'blocked',
                rootDir,
              });
            }
          }
          return {
            ...base,
            ...(state ? { project_id: state.project_id, missions: state.missions } : {}),
            ...(statePath ? { state_path: statePath } : {}),
            status: noManagedEffects ? 'failed' : 'blocked',
            reason,
          };
        }
      }
    );
    rows.push(row);
  }
  return rows;
}
