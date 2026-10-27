/**
 * Dot state paths and row contracts for the resident-dot organization loop.
 *
 * Domain root `active/shared/runtime/dot/<tier>/<tenant|shared>/`;
 * personal state adds the authenticated owner's hash. Private prose never
 * enters the shared control indexes. Legacy unclassified state is held for
 * explicit operator-reviewed migration rather than silently starting blank.
 */

import { assertPhysicalScopeSegment, physicalScopedPath } from '../physical-namespace.js';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { writeJson } from '../foundation/json.js';
import { readJsonLinesCached } from '../jsonl-tail.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { assertScopeContext } from '../scope-context-validation.js';
import { storagePartitionSegments } from '../storage-layout.js';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  runtimeStatePath,
} from '../foundation/runtime-state-roots.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDecisionLevel, DotProposal } from './dot-proposals.js';

export const DOT_STATE_ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.dot;

const LEGACY_DOT_ENTRIES = new Set([
  'work-results.jsonl',
  'kr-ledger.jsonl',
  'org-kr-ledger.jsonl',
  'outcomes.jsonl',
  'outcome-pending.jsonl',
  'followups.jsonl',
  'events.jsonl',
  'memory-distill.jsonl',
  'autonomy-shadow.jsonl',
  'arbitration.jsonl',
  'digest-ledger.jsonl',
  'wake-errors.jsonl',
  'memory',
  'autonomy',
  'feed',
  'wake-circuit',
  'event-continuations',
  'org-cadence.json',
]);
function legacyDotStateRoot(c: DotCharter): string {
  return physicalScopedPath(DOT_STATE_ROOT, {
    tenant_slug: c.scope.tenant_slug,
    organization_id: c.scope.organization_id,
  });
}
function legacyEntries(c: DotCharter, root: string): string[] {
  const dir = path.join(root, legacyDotStateRoot(c));
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter(
      (entry) => LEGACY_DOT_ENTRIES.has(entry) || /^continuous-cadence-[a-f0-9]+\.json$/.test(entry)
    )
    .filter((entry) => {
      const source = path.join(dir, entry);
      if (['memory', 'autonomy'].includes(entry))
        return safeExistsSync(path.join(source, `${c.dot_id}.json`));
      if (entry.endsWith('.jsonl') && safeLstat(source).isFile()) {
        const rows = String(safeReadFile(source))
          .split('\n')
          .filter((line) => line.trim());
        return rows.some((line) => {
          try {
            const row = JSON.parse(line);
            return !row.dot_id || row.dot_id === c.dot_id;
          } catch {
            return true;
          }
        });
      }
      return true;
    });
}
/** Never start a blank state alongside unclassified historical content. */
export function assertDotStateLayoutReady(c: DotCharter, root = pathResolver.rootDir()): void {
  const entries = legacyEntries(c, root);
  const legacyActions = readJsonLinesCached<{ dot_id?: string; scope?: unknown }>(
    path.join(root, runtimeStatePath('dot.actionLedger').physicalPath)
  );
  if (legacyActions.some((row) => row.dot_id === c.dot_id && !row.scope))
    entries.push('shared legacy action records');
  const tenantEvents = physicalScopedPath(
    DOT_STATE_ROOT,
    { tenant_slug: c.scope.tenant_slug },
    'events.jsonl'
  );
  if (c.scope.organization_id && safeExistsSync(path.join(root, tenantEvents)))
    entries.push('tenant/events.jsonl');
  if (entries.length)
    throw new Error(
      `[DOT_STATE_MIGRATION_REQUIRED] ${c.dot_id} has legacy state without a trustworthy tier — next: review its source tier/tenant/owner, then pnpm kyberion dot migrate-state ${c.dot_id} --legacy-tier ${c.scope.tier} --apply | evidence: ${legacyDotStateRoot(c)}`
    );
}
/** Explicit reviewed relocation; no tier/owner is inferred from the current charter. */
export function migrateLegacyDotState(
  c: DotCharter,
  reviewedScope: DotCharter['scope'],
  root = pathResolver.rootDir()
): { moved: string[]; destination: string } {
  const actor = resolvePolicyIdentityContext();
  if (!['sovereign', 'ecosystem_architect'].includes(actor.persona))
    throw new Error(
      '[DOT_STATE_MIGRATION_AUTHORITY] legacy classification requires an authorized operator'
    );
  if (
    JSON.stringify([
      reviewedScope.tier,
      reviewedScope.tenant_slug ?? '',
      reviewedScope.organization_id ?? '',
      reviewedScope.owner_nhi ?? '',
    ]) !==
    JSON.stringify([
      c.scope.tier,
      c.scope.tenant_slug ?? '',
      c.scope.organization_id ?? '',
      c.scope.owner_nhi ?? '',
    ])
  )
    throw new Error(
      '[DOT_STATE_MIGRATION_SCOPE] reviewed legacy scope must exactly match the destination'
    );
  const source = path.join(root, legacyDotStateRoot(c));
  const destination = path.join(root, dotStatePath(c));
  return withLockSync(
    'dot-state-migrate:' + createHash('sha256').update(source).digest('hex'),
    () => {
      const entries = legacyEntries(c, root);
      // Plan and validate every ownership boundary before writing any destination.
      // The old public/personal root was shared: selecting one charter never
      // authorizes moving its neighbours or an unowned aggregate.
      const plans = entries.map((entry) => {
        const src = path.join(source, entry);
        if (['memory', 'autonomy'].includes(entry))
          return {
            entry,
            src: path.join(src, `${c.dot_id}.json`),
            dest: path.join(destination, entry, `${c.dot_id}.json`),
          };
        if (entry.endsWith('.jsonl') && safeLstat(src).isFile()) {
          const lines = String(safeReadFile(src))
            .split('\n')
            .filter((line) => line.trim());
          const rows = lines.map((line) => {
            try {
              const row = JSON.parse(line);
              if (typeof row.dot_id === 'string' && row.dot_id) return { line, row };
            } catch {
              /* fail closed below */
            }
            throw new Error(
              '[DOT_STATE_MIGRATION_OWNERSHIP] unowned legacy record — next: classify and recover this source separately; no namespace-wide relocation is permitted'
            );
          });
          for (const { row } of rows) {
            if (
              row.dot_id === c.dot_id &&
              row.scope &&
              ['tier', 'tenant_slug', 'owner_nhi', 'organization_id', 'project_id'].some(
                (key) =>
                  (row.scope[key] ?? '') !==
                  (reviewedScope[key as keyof typeof reviewedScope] ?? '')
              )
            )
              throw new Error(
                '[DOT_STATE_MIGRATION_SCOPE] tagged legacy record conflicts with the reviewed destination; preserve and recover it separately'
              );
          }
          return {
            entry,
            src,
            dest: path.join(destination, entry),
            selected: rows.filter(({ row }) => row.dot_id === c.dot_id).map(({ line }) => line),
            remaining: rows.filter(({ row }) => row.dot_id !== c.dot_id).map(({ line }) => line),
          };
        }
        throw new Error(
          '[DOT_STATE_MIGRATION_OWNERSHIP] aggregate or unknown legacy state requires separate ownership classification; recover it without relocating the shared namespace'
        );
      });
      const tenantEventSource = path.join(
        root,
        physicalScopedPath(DOT_STATE_ROOT, { tenant_slug: c.scope.tenant_slug }, 'events.jsonl')
      );
      const migrateTenantEvents = Boolean(
        c.scope.organization_id && safeExistsSync(tenantEventSource)
      );
      if (migrateTenantEvents)
        throw new Error(
          '[DOT_STATE_MIGRATION_OWNERSHIP] tenant-wide events require separate source-scope classification; no single-dot relocation is permitted'
        );
      const writes = plans.map((plan) => {
        if (!plan.selected) {
          const stat = safeLstat(plan.src);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('[DOT_STATE_MIGRATION_TYPE] selected state must be a regular file');
          const bytes = safeReadFile(plan.src);
          if (
            safeExistsSync(plan.dest) &&
            !Buffer.from(safeReadFile(plan.dest)).equals(Buffer.from(bytes))
          )
            throw new Error(
              '[DOT_STATE_MIGRATION_CONFLICT] destination differs; inspect both copies before recovery'
            );
          return { dest: plan.dest, bytes };
        }
        const existing = safeExistsSync(plan.dest)
          ? String(safeReadFile(plan.dest))
              .split('\n')
              .filter((line) => line.trim())
          : [];
        const merged = [...existing];
        const identities = new Map<string, string>();
        const identity = (row: Record<string, unknown>) =>
          JSON.stringify([
            row.dot_id,
            ...[
              'id',
              'action_ref',
              'work_item_id',
              'kr_id',
              'objective_id',
              'event_id',
              'at',
              'measured_at',
              'started_at',
              'completed_at',
              'created_at',
            ].map((key) => row[key] ?? null),
          ]);
        const validate = (line: string): Record<string, unknown> => {
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            throw new Error('[DOT_STATE_MIGRATION_CONFLICT] malformed destination evidence');
          }
          if (
            !row ||
            typeof row.dot_id !== 'string' ||
            !row.scope ||
            ['tier', 'tenant_slug', 'owner_nhi', 'organization_id', 'project_id'].some(
              (key) =>
                (row.scope[key] ?? '') !== (reviewedScope[key as keyof typeof reviewedScope] ?? '')
            )
          )
            throw new Error(
              '[DOT_STATE_MIGRATION_SCOPE] destination evidence lacks matching reviewed scope'
            );
          return row;
        };
        for (const line of existing) {
          const row = validate(line);
          const key = identity(row);
          const canonical = JSON.stringify(row);
          if (identities.has(key) && identities.get(key) !== canonical)
            throw new Error(
              '[DOT_STATE_MIGRATION_CONFLICT] destination row identity has conflicting evidence'
            );
          identities.set(key, canonical);
        }
        for (const line of plan.selected) {
          const row = { ...JSON.parse(line), scope: reviewedScope };
          const canonical = JSON.stringify(row);
          const key = identity(row);
          if (identities.has(key)) {
            if (identities.get(key) !== canonical)
              throw new Error(
                '[DOT_STATE_MIGRATION_CONFLICT] selected row identity conflicts with destination evidence'
              );
          } else {
            identities.set(key, canonical);
            merged.push(canonical);
          }
        }
        return { dest: plan.dest, bytes: merged.join('\n') + '\n' };
      });
      // All destination conflicts are checked before the first mutation.
      for (const write of writes) {
        safeMkdir(path.dirname(write.dest), { recursive: true });
        safeWriteFile(write.dest, write.bytes);
      }
      // Sources survive every failed copy. Equal existing bytes make interrupted
      // migrations replayable; only a complete verified copy removes originals.
      writeJson(path.join(destination, 'migration.json'), {
        version: 1,
        scope: reviewedScope,
        source,
        moved: entries,
        ...(migrateTenantEvents ? { tenant_events_source: tenantEventSource } : {}),
        actor: actor.role ?? actor.persona,
        migrated_at: new Date().toISOString(),
      });
      for (const plan of plans) {
        if (plan.remaining?.length) safeWriteFile(plan.src, plan.remaining.join('\n') + '\n');
        else safeRmSync(plan.src, { force: true });
      }
      if (migrateTenantEvents) safeRmSync(tenantEventSource, { force: true });
      return { moved: entries, destination };
    }
  );
}

/** Repo-relative path under the dot state domain for this charter's scope. */
export function dotStatePath(charter: Pick<DotCharter, 'scope'>, ...parts: string[]): string {
  assertScopeContext(charter.scope, { allowShared: true });
  const { tier, tenant_slug, organization_id, project_id } = charter.scope;
  const partition = storagePartitionSegments({ kind: 'tier', tier, tenant: tenant_slug });
  if (tier === 'personal' && !charter.scope.owner_nhi?.trim())
    throw new Error('[DOT_PERSONAL_OWNER] personal state requires owner_nhi');
  return [
    DOT_STATE_ROOT,
    ...partition,
    ...(tier === 'personal'
      ? ['owners', createHash('sha256').update(charter.scope.owner_nhi!).digest('hex')]
      : []),
    ...(organization_id
      ? ['organizations', assertPhysicalScopeSegment(organization_id, 'organization_id')]
      : []),
    ...(project_id ? ['projects', assertPhysicalScopeSegment(project_id, 'project_id')] : []),
    ...parts.flatMap((part) =>
      part.split('/').map((segment) => assertPhysicalScopeSegment(segment, 'dot state path'))
    ),
  ].join('/');
}

export const DOT_WORK_RESULTS_FILE = 'work-results.jsonl';
export const DOT_KR_LEDGER_FILE = 'kr-ledger.jsonl';
export const DOT_ORG_KR_LEDGER_FILE = 'org-kr-ledger.jsonl';

/** Repo-relative org-scoped KR ledger path (`org-kr-ledger.jsonl`). */
export function orgKrLedgerPath(scope: {
  ownerNhi?: string;
  tier?: DotCharter['scope']['tier'];
  tenantSlug?: string;
  organizationId?: string;
}): string {
  // Untenanted organizations share the flat ledger; rows carry organization_id.
  return dotStatePath(
    {
      scope: {
        tier: scope.tier ?? (scope.tenantSlug ? 'confidential' : 'public'),
        owner_nhi: scope.ownerNhi,
        tenant_slug: scope.tenantSlug,
        organization_id: scope.organizationId,
      },
    } as DotCharter,
    DOT_ORG_KR_LEDGER_FILE
  );
}
export const DOT_OUTCOMES_FILE = 'outcomes.jsonl';
export const DOT_OUTCOME_PENDING_FILE = 'outcome-pending.jsonl';
export const DOT_FOLLOWUPS_FILE = 'followups.jsonl';
export const DOT_EVENTS_FILE = 'events.jsonl';
/** Per-feed cursor/seen state: `feed/<specId>.json` under the dot state domain. */
export const DOT_FEED_DIR = 'feed';
export const DOT_MEMORY_DIR = 'memory';
export const DOT_MEMORY_DISTILL_FILE = 'memory-distill.jsonl';
export const DOT_AUTONOMY_DIR = 'autonomy';
export const DOT_AUTONOMY_SHADOW_FILE = 'autonomy-shadow.jsonl';
export const DOT_ARBITRATION_FILE = 'arbitration.jsonl';

export const dotMemoryPath = (charter: DotCharter): string =>
  dotStatePath(charter, DOT_MEMORY_DIR, `${charter.dot_id}.json`);
export const dotAutonomyStatePath = (charter: DotCharter): string =>
  dotStatePath(charter, DOT_AUTONOMY_DIR, `${charter.dot_id}.json`);

/** DL-01: one executed (or refused) delegated work item. */
export interface FrontDeskArtifactVerification {
  artifact_path: string;
  sha256: string;
  request_digest: string;
  revision: number;
  verified_at: string;
}

export interface DotWorkResultRow {
  awaiting_approval?: boolean;
  pipeline_run_id?: string;
  approval_request_id?: string;
  storage_channel?: string;
  /** Readback evidence, persisted before releasing the request WorkItem. */
  front_desk_verification?: FrontDeskArtifactVerification;
  dot_id: string;
  work_item_id: string;
  action_ref: string;
  attempt_id?: string;
  mode: 'goal_turn' | 'delegated' | 'pipeline' | 'escalated';
  status: 'done' | 'blocked' | 'failed' | 'skipped';
  /** At most 600 chars. */
  summary: string;
  started_at: string;
  completed_at: string;
  tokens_used?: number;
  /** Persisted before releasing work so report recovery survives a missing WorkItem. */
  report_to_dot_id?: string;
  /** Durable inbox receipt observed; suppresses re-delivery after inbox retention. */
  report_enqueued_at?: string;
  /** Reported without waking the dot (it reads the result on its next wake). */
  report_suppressed?: 'capability_unavailable';
  /**
   * Why the item stopped: `capability_unavailable` (this runtime cannot run the
   * shape — no wake), `pre_effect_failure` (failed before any port effect, so
   * it is retryable rather than quarantined).
   */
  reason_code?: 'capability_unavailable' | 'pre_effect_failure';
  kr_snapshot?: Record<string, number>;
  /** Latest health (1 healthy / 0) per signal, captured at claim time — the "before" of a signal effect. */
  signal_snapshot?: Record<string, 0 | 1>;
}

/** DL-03: one key-result measurement. */
export interface KrMeasurementRow {
  scope: 'dot' | 'org';
  dot_id?: string;
  organization_id?: string;
  objective_id?: string;
  kr_id: string;
  value: number;
  progress: number;
  measured_at: string;
}

/** DL-04: verdict on whether a completed action moved its KR/signal. */
export interface DotOutcomeRow {
  dot_id: string;
  action_ref: string;
  work_item_id: string;
  ref: { kr_id?: string; signal?: string };
  before?: number;
  after?: number;
  verdict: 'improved' | 'no_change' | 'regressed' | 'unmeasurable';
  due_at: string;
  measured_at: string;
}

/** DL-05: per-dot working memory document. */
export interface DotMemoryDoc {
  dot_id: string;
  version: 1;
  updated_at: string;
  /** Durable ID high-water marks, retained when entries are removed or evicted. */
  last_ids?: { n: number; i: number; h: number };
  notes: Array<{ id: string; text: string; at: string }>;
  open_items: Array<{
    id: string;
    text: string;
    status: 'open' | 'closed';
    due?: string;
    at: string;
  }>;
  hypotheses: Array<{
    id: string;
    text: string;
    confidence: number;
    status: 'open' | 'confirmed' | 'refuted';
    at: string;
  }>;
}

/** DL-09: a self-scheduled follow-up wake. */
export interface DotFollowupRow {
  followup_id: string;
  dot_id: string;
  due_at: string;
  reason: string;
  created_at: string;
  /** A committed successor consumes this parent independently of wake-ledger delivery. */
  replaces_followup_id?: string;
}

/** DL-08: a normalized inbound event, as stored in `events.jsonl`. */
export interface DotInboundEvent {
  event_id: string;
  source: string;
  type: string;
  delivery_id: string;
  /** Only ever set from intake policy, never from the payload. */
  tenant_slug?: string;
  /**
   * Set only by operator ask intake from the trusted selected scope, never
   * from the payload. When present, only dots of this organization see it.
   */
  organization_id?: string;
  received_at: string;
  summary: string;
  payload_digest: string;
  /** At most 16 KB serialized. */
  payload: unknown;
}

/** DL-10: autonomy ladder level. */
export type DotAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export const DOT_AUTONOMY_LEVELS: readonly DotAutonomyLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface DotAutonomyState {
  level: DotAutonomyLevel;
  since: string;
  history: Array<{ level: DotAutonomyLevel; at: string; reason: string }>;
}

/**
 * DL-11: one arbitration decision between two dots' proposals. Pre-gate rows
 * know the newcomer only by `proposal_hash` (its action_ref is assigned after
 * the check); settlement rows (`superseded` / `declined`) carry `action_ref`.
 */
export interface DotArbitrationRow {
  at: string;
  dot_id: string;
  proposal_hash: string;
  action_ref?: string;
  conflicts_with: { dot_id: string; action_ref: string };
  target?: string;
  intent?: DotProposal['intent'];
  resolution:
    'proceed' | 'defer_to_owner' | 'defer_to_priority' | 'escalated' | 'superseded' | 'declined';
  floor?: DotDecisionLevel;
  reason: string;
}
