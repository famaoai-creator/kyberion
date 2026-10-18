/** Bounded snapshot-to-work orchestration. Source acquisition belongs to tenant-ingest. */
import '../dot/dot-extension-bootstrap.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { safeExistsSync, safeReadFileSnapshot, safeWriteFile, safeRealpath } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { pathResolver } from '../path-resolver.js';
import { storagePartitionSegments } from '../storage-layout.js';
import { listDotCharters, type DotCharter } from '../dot/dot-charter.js';
import {
  dispatchDotProposals,
  dotDelegationCapacity,
  type DotDispatchResult,
} from '../dot/dot-dispatch.js';
import { readDotActionLedgerStrict } from '../dot/dot-action-ledger.js';
import { assertScopedCadenceExecution } from './organization-cadence.js';
import {
  parseContinuousOperationsConfig,
  parseContinuousObservations,
  evaluateContinuousOperations,
  type ContinuousOperationsConfig,
  type ContinuousOperationsCandidate,
  type ContinuousSourceSnapshot,
} from './continuous-operations-policy.js';

interface RuleState {
  semantic_hash: string;
  generation: number;
  healthy: boolean;
  value: number;
  operation_key?: string;
  admitted_at?: string;
  status?: string;
  action_ref?: string;
  work_item_id?: string;
  error?: string;
  observed_at: string;
  evidence_refs: string[];
  objective_ref: string;
}
interface LoopState {
  version: 1;
  identity: string;
  rules: Record<string, RuleState>;
}
export interface ContinuousOperationsInventoryRow {
  rule_id: string;
  disposition:
    'proposed' | 'duplicate' | 'cooldown' | 'recovered' | 'not_triggered' | 'limited' | 'error';
  previous_value?: number;
  current_value: number;
  delta?: number;
  evidence_refs: string[];
  observed_at: string;
  objective_ref: string;
  dot_status?: string;
  action_ref?: string;
  work_item_id?: string;
  error?: string;
  reason?: string;
}
export interface ContinuousOperationsReport {
  loop_id: string;
  scope: ContinuousOperationsConfig['scope'];
  applied: boolean;
  state_path: string;
  inventory: ContinuousOperationsInventoryRow[];
}
/** Injectable persistence/authority seams keep tests hermetic; production callers omit these. */
export interface ContinuousOperationsDeps {
  capacity?: (charter: DotCharter) => { cap: number; open: number; free: number };
  authorize?: (config: ContinuousOperationsConfig, charter: DotCharter) => void;
  charters?: (rootDir: string) => DotCharter[];
  read?: (file: string) => unknown;
  exists?: (file: string) => boolean;
  write?: (file: string, value: unknown) => void;
  lock?: <T>(key: string, fn: () => T) => T;
  dispatch?: (
    charter: DotCharter,
    candidate: ContinuousOperationsCandidate,
    operationKey: string
  ) => DotDispatchResult;
}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CONTINUOUS_SOURCE_MAX_BYTES = 1_048_576;
export const CONTINUOUS_STATE_MAX_BYTES = 32 * 1_048_576;
const readBounded = (file: string, maxBytes: number): unknown =>
  parseSafeJsonInput(
    safeReadFileSnapshot(file, maxBytes).toString('utf8'),
    'continuous operations snapshot'
  );
function authorize(config: ContinuousOperationsConfig, charter: DotCharter): void {
  const scope = config.scope;
  const role = assertScopedCadenceExecution('continuous operations', {
    tier: scope.tier,
    tenantSlug: scope.tenant_slug,
    organizationId: scope.organization_id,
  });
  const execution = currentExecutionScope();
  if (
    execution?.organizationId !== scope.organization_id ||
    role !== charter.authority.authority_role
  ) {
    throw new Error(
      'Continuous operations requires the exact organization and charter authority role'
    );
  }
}
function parseState(value: unknown, identity: string): LoopState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid continuous operations state');
  const state = value as LoopState;
  if (Object.keys(state).some((key) => !['version', 'identity', 'rules'].includes(key)))
    throw new Error('Invalid continuous operations state fields');
  if (
    state.version !== 1 ||
    state.identity !== identity ||
    !state.rules ||
    typeof state.rules !== 'object' ||
    Array.isArray(state.rules) ||
    Object.keys(state.rules).length > 1000
  )
    throw new Error('Invalid continuous operations state');
  for (const row of Object.values(state.rules)) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.semantic_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.semantic_hash) ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 0 ||
      typeof row.healthy !== 'boolean' ||
      !Number.isFinite(row.value)
    )
      throw new Error('Invalid continuous operations rule state');
    if (
      Object.keys(row).some(
        (key) =>
          ![
            'semantic_hash',
            'generation',
            'healthy',
            'value',
            'operation_key',
            'admitted_at',
            'status',
            'action_ref',
            'work_item_id',
            'error',
            'observed_at',
            'evidence_refs',
            'objective_ref',
          ].includes(key)
      )
    )
      throw new Error('Invalid continuous operations rule state fields');
    if (
      typeof row.observed_at !== 'string' ||
      !Number.isFinite(Date.parse(row.observed_at)) ||
      typeof row.objective_ref !== 'string' ||
      row.objective_ref.length > 512 ||
      !Array.isArray(row.evidence_refs) ||
      row.evidence_refs.length !== 1 ||
      row.evidence_refs.some((ref) => typeof ref !== 'string' || ref.length > 1024)
    )
      throw new Error('Invalid continuous operations observation provenance');
    for (const field of ['operation_key', 'status', 'action_ref', 'work_item_id', 'error'] as const)
      if (row[field] !== undefined && (typeof row[field] !== 'string' || row[field]!.length > 4000))
        throw new Error('Invalid continuous operations state field');
    if (
      row.admitted_at !== undefined &&
      (typeof row.admitted_at !== 'string' || !Number.isFinite(Date.parse(row.admitted_at)))
    )
      throw new Error('Invalid continuous operations admission time');
    if (row.operation_key && !row.admitted_at)
      throw new Error('Incomplete continuous operations admission state');
  }
  return state;
}

export function runContinuousOperations(
  input: unknown,
  options: {
    apply?: boolean;
    recoverAdmissions?: boolean;
    now?: Date;
    rootDir?: string;
    snapshots?: ContinuousSourceSnapshot[];
  } = {},
  deps: ContinuousOperationsDeps = {}
): ContinuousOperationsReport {
  const config = parseContinuousOperationsConfig(input);
  const now = options.now ?? new Date();
  const root = options.rootDir ?? pathResolver.rootDir();
  const identity = hash({ loop: config.loop_id, dot: config.dot_id, scope: config.scope });
  const statePath = path.join(
    root,
    'active/shared/runtime',
    ...storagePartitionSegments({
      kind: 'tier',
      tier: config.scope.tier,
      tenant: config.scope.tenant_slug,
    }),
    'continuous-operations',
    identity,
    'state.json'
  );
  const charter = (deps.charters ?? ((dir) => listDotCharters(dir).map((row) => row.charter)))(
    root
  ).find(
    (row) =>
      row.dot_id === config.dot_id &&
      row.status === 'active' &&
      row.scope.tier === config.scope.tier &&
      row.scope.tenant_slug === config.scope.tenant_slug &&
      row.scope.organization_id === config.scope.organization_id &&
      row.scope.project_id === config.scope.project_id
  );
  if (!charter)
    throw new Error('Continuous operations requires an active dot charter with exact scope');
  (deps.authorize ?? authorize)(config, charter);
  if (!config.enabled)
    return {
      loop_id: config.loop_id,
      scope: config.scope,
      applied: false,
      state_path: statePath,
      inventory: [],
    };
  const read = deps.read ?? ((file: string) => readBounded(file, CONTINUOUS_SOURCE_MAX_BYTES));
  const assertStatePath = (): void => {
    let existing = statePath;
    while (!safeExistsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing)
        throw new Error('Continuous operations state path has no existing root');
      existing = parent;
    }
    const relative = path.relative(root, existing);
    if (safeRealpath(existing) !== path.resolve(safeRealpath(root), relative))
      throw new Error('Continuous operations state path must not traverse symlinks');
  };
  const write = (file: string, value: unknown): void => {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > CONTINUOUS_STATE_MAX_BYTES)
      throw new Error('Continuous operations state exceeds bounded storage limit');
    if (deps.write) deps.write(file, value);
    else {
      assertStatePath();
      safeWriteFile(file, serialized);
    }
  };
  const apply = options.apply === true && config.enabled;
  return (deps.lock ?? withLockSync)(`continuous-operations-${identity}`, () => {
    // Validate every source before changing any checkpoint or admitting any work.
    const snapshots =
      options.snapshots ??
      config.sources.map((source) => {
        if (!('path' in source) || (source.kind !== undefined && source.kind !== 'snapshot'))
          throw new Error(
            'Continuous operations non-snapshot source requires the async cycle collector'
          );
        const sourcePath = path.join(root, source.path);
        if (!deps.read && safeRealpath(sourcePath) !== path.join(safeRealpath(root), source.path))
          throw new Error('Continuous operations source path must not traverse symlinks');
        return {
          source_id: source.source_id,
          observations: parseContinuousObservations(read(sourcePath)),
        };
      });
    const validatedSnapshots = snapshots.map((snapshot) => ({
      source_id: snapshot.source_id,
      observations: parseContinuousObservations(snapshot.observations),
    }));
    const candidates = evaluateContinuousOperations(config, validatedSnapshots, now);
    if (!deps.read) assertStatePath();
    const state = (deps.exists ?? safeExistsSync)(statePath)
      ? parseState(
          deps.read ? deps.read(statePath) : readBounded(statePath, CONTINUOUS_STATE_MAX_BYTES),
          identity
        )
      : { version: 1 as const, identity, rules: {} as Record<string, RuleState> };
    const inventory: ContinuousOperationsInventoryRow[] = [];
    if (
      new Set([...Object.keys(state.rules), ...config.rules.map((rule) => rule.rule_id)]).size >
      1000
    )
      throw new Error(
        'Continuous operations rule history limit reached; archive this loop before adding rules'
      );
    let admitted = 0;
    for (const rule of config.rules) {
      const observation = validatedSnapshots
        .find((source) => source.source_id === rule.source_id)!
        .observations.find((row) => row.metric === rule.metric);
      if (!observation)
        throw new Error(`Continuous operations missing metric ${rule.source_id}/${rule.metric}`);
      const semantic = hash({
        rule,
        source: config.sources.find((source) => source.source_id === rule.source_id),
      });
      const old = Object.hasOwn(state.rules, rule.rule_id) ? state.rules[rule.rule_id] : undefined;
      const prior = old?.semantic_hash === semantic ? old : undefined;
      const candidate = candidates.find((row) => row.rule_id === rule.rule_id);
      const provenance = {
        observed_at: observation.observed_at,
        evidence_refs: [observation.evidence_ref],
        objective_ref: rule.objective_ref,
      };
      const row: ContinuousOperationsInventoryRow = {
        rule_id: rule.rule_id,
        disposition: 'not_triggered',
        current_value: observation.value,
        ...provenance,
        ...(old ? { previous_value: old.value, delta: observation.value - old.value } : {}),
      };
      inventory.push(row);
      const next: RuleState = prior
        ? { ...prior, ...provenance, value: observation.value }
        : {
            semantic_hash: semantic,
            generation: old?.generation ?? 0,
            healthy: true,
            value: observation.value,
            ...provenance,
            ...(old?.admitted_at ? { admitted_at: old.admitted_at } : {}),
          };
      if (!candidate) {
        // Healthy observations still monitor the work already admitted in this semantic episode.
        // A newly triggered episode below must not borrow that earlier action's execution identity.
        if (prior?.action_ref) {
          row.action_ref = prior.action_ref;
          row.work_item_id = prior.work_item_id;
          row.dot_status = prior.status;
        }
        if (prior && !prior.healthy) row.disposition = 'recovered';
        next.healthy = true;
        next.status = 'healthy';
        delete next.error;
        state.rules[rule.rule_id] = next;
        continue;
      }
      if (
        (next.status === 'admission_error' || next.status === 'refused') &&
        options.recoverAdmissions !== true
      ) {
        Object.assign(row, { disposition: 'error', dot_status: next.status, error: next.error });
        state.rules[rule.rule_id] = next;
        continue;
      }
      const recovery = next.status === 'admission_intent' || next.status === 'admission_error';
      if (next.status === 'refused' && options.recoverAdmissions === true) {
        // Explicit recovery acknowledges the refusal without replaying its immutable admission.
        // Retain its cooldown and generation; a later admission receives a fresh identity.
        next.healthy = true;
        next.status = 'healthy';
        delete next.error;
        delete next.operation_key;
        delete next.action_ref;
        delete next.work_item_id;
      }
      if (!next.healthy && !recovery) {
        Object.assign(row, {
          disposition: 'duplicate',
          dot_status: next.status,
          action_ref: next.action_ref,
          work_item_id: next.work_item_id,
        });
        state.rules[rule.rule_id] = next;
        continue;
      }
      if (
        !recovery &&
        next.admitted_at &&
        now.getTime() - Date.parse(next.admitted_at) < config.cooldown_seconds * 1000
      ) {
        row.disposition = 'cooldown';
        state.rules[rule.rule_id] = next;
        continue;
      }
      if (admitted >= config.max_proposals_per_run) {
        row.disposition = 'limited';
        continue;
      }
      // Recover an immutable admission in place: its own parked record may already occupy a slot.
      // New admissions re-read live capacity so earlier rules in this same run consume slots.
      if (apply && !recovery) {
        const capacity = deps.capacity
          ? deps.capacity(charter)
          : deps.dispatch
            ? {
                cap: config.max_proposals_per_run,
                open: admitted,
                free: config.max_proposals_per_run - admitted,
              }
            : dotDelegationCapacity(charter, { rootDir: root });
        if (capacity.free <= 0) {
          row.disposition = 'limited';
          row.reason = `Delegation capacity reached (${capacity.open}/${capacity.cap}); retry when a slot is free`;
          state.rules[rule.rule_id] = next;
          continue;
        }
      }
      admitted += 1;
      row.disposition = recovery ? 'recovered' : 'proposed';
      if (!apply) continue;
      if (!recovery) {
        if (next.generation >= Number.MAX_SAFE_INTEGER)
          throw new Error('Continuous operations episode counter exhausted');
        next.generation += 1;
        next.operation_key = `continuous:${identity}:${semantic}:${next.generation}`;
        next.admitted_at = now.toISOString();
        delete next.action_ref;
        delete next.work_item_id;
      }
      next.healthy = false;
      next.status = 'admission_intent';
      delete next.error;
      state.rules[rule.rule_id] = next;
      write(statePath, state); // Persist immutable operation identity before the external admission.
      try {
        const result = deps.dispatch
          ? deps.dispatch(charter, candidate, next.operation_key!)
          : dispatchDotProposals(charter, [candidate.proposal], {
              rootDir: root,
              operationKey: next.operation_key!,
              now: () => now,
            });
        const record =
          result.records[0] ??
          (!deps.dispatch && result.duplicates[0]
            ? readDotActionLedgerStrict({ rootDir: root })
                .filter((row) => row.action_ref === result.duplicates[0])
                .at(-1)
            : undefined);
        if (!record && result.duplicates.length === 0)
          throw new Error('Dot admission returned no disposition');
        next.status = record?.status ?? 'duplicate';
        next.action_ref = record?.action_ref ?? result.duplicates[0];
        next.work_item_id = record?.work_item_id;
        Object.assign(row, {
          dot_status: next.status,
          action_ref: next.action_ref,
          work_item_id: next.work_item_id,
          reason: record?.reason,
        });
        if (next.status === 'refused') {
          next.error = record?.reason ?? 'Dot admission refused';
          row.disposition = 'error';
          row.error = next.error;
        }
      } catch (error) {
        next.status = 'admission_error';
        next.error = error instanceof Error ? error.message.slice(0, 4000) : 'Admission failed';
        row.disposition = 'error';
        row.error = next.error;
        row.dot_status = next.status;
      }
      write(statePath, state);
    }
    if (apply) {
      write(statePath, state);
    }
    return {
      loop_id: config.loop_id,
      scope: config.scope,
      applied: apply,
      state_path: statePath,
      inventory,
    };
  });
}
