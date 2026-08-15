/**
 * NI-01: Canonical AgentIdentity record + durable registry.
 *
 * Before this module, agent identity was split across six representations
 * (in-memory `agent-registry` AgentRecord, agent-manifest declarations,
 * `resolveRole()` env/proc heuristics, mission-state personas,
 * work-coordination free-string peer ids, mission-team-binding resource ids)
 * with no ledger of "when was this agent identity born, who owns it, when was
 * it retired". This module is that ledger: a journal-backed, event-sourced
 * registry of Non-Human Identities (NHI), modeled 1:1 on the SO-02
 * OrchestratorSession pattern (`orchestrator-session.ts`): dedicated JSONL
 * journal + pure idempotent reducers + corrupt-line-tolerant replay + governed
 * writes with ungated reads, on its OWN {@link EventSourcingKernel} instance
 * (never the shared `workerStateKernel` singleton).
 *
 * Canonical identity id (`nhi_id`) is a stable URI, SPIFFE-shaped
 * (`kyberion://agent/<org>/<slug>`); the slug is the same grammar as
 * agent-manifest `agentId` (`^[a-z][a-z0-9-]*$`), so a manifest's agentId is
 * reconciled against the ledger as the slug of a provisioned identity.
 * provider/model are *hints*, not identity (AO-05).
 *
 * Invariants:
 *   1. **Accountable ownership, fail-closed** — every `agent`/`service`
 *      identity MUST carry a non-empty `accountable_human_id`
 *      ({@link issueAgentIdentity} throws otherwise), mirroring the CO-06
 *      workforce-resource invariant enforced in `mission-team-binding.ts`
 *      (`resolveAssignmentResource`).
 *   2. **No identity reuse** — an `nhi_id` is issued once. Re-issuing an
 *      existing *non-retired* identity with identical core params is
 *      idempotent (returns the existing record); differing params conflict;
 *      re-issuing a *retired* identity always conflicts (OWASP NHI Top 10:
 *      identity reuse). Retire and mint a new slug/org instead.
 *   3. **Governed writes, ungated reads** — see
 *      {@link AGENT_IDENTITY_WRITE_ROLES} for the write allowlist rationale.
 *      Reads (`getAgentIdentity`, `listAgentIdentities`) never gate.
 *   4. **No cross-process-stale cache** — every read re-projects from the
 *      journal (SO-02 review lesson): multiple processes (mission controller
 *      CLI, surface daemons, runtime supervisor) share this journal, so a
 *      cached projection could miss another process's issue/retire.
 *   5. **Instance != identity** — `bindRuntimeInstance`/
 *      `releaseRuntimeInstance` track ephemeral runtime instances (the
 *      in-memory `agent-registry` agentId + pid/session info) against the
 *      durable identity; releasing an instance never retires the identity.
 */

import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { resolveRole, withExecutionContext } from './authority.js';
import { loadOrganizationProfile } from './organization-profile.js';
import { isValidTenantSlug } from './entity-scope.js';
import { logger } from './core.js';
import {
  EventSourcingKernel,
  appendValidatedJournalEvent,
  journalEventEnvelopeSchema,
  runInRestoreMode,
  type JournalEventEnvelope,
} from './worker-state-journal.js';

// ---------------------------------------------------------------------------
// NHI id: kyberion://agent/<org>/<slug> (SPIFFE-shaped URI; NI-05 maps it out)
// ---------------------------------------------------------------------------

/** Same grammar as agent-manifest `agentId` validation (`agent-manifest.ts`). */
export const NHI_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export const NHI_ID_PREFIX = 'kyberion://agent/';

export const NHI_ID_PATTERN = /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export class AgentIdentityFormatError extends Error {
  constructor(message: string) {
    super(`[agent-identity] ${message}`);
    this.name = 'AgentIdentityFormatError';
  }
}

/** Build a canonical nhi_id. Throws {@link AgentIdentityFormatError} on invalid org/slug. */
export function buildNhiId(organizationId: string, slug: string): string {
  if (!NHI_SLUG_PATTERN.test(organizationId)) {
    throw new AgentIdentityFormatError(
      `invalid organization id "${organizationId}" (must match ${NHI_SLUG_PATTERN})`
    );
  }
  if (!NHI_SLUG_PATTERN.test(slug)) {
    throw new AgentIdentityFormatError(`invalid slug "${slug}" (must match ${NHI_SLUG_PATTERN})`);
  }
  return `${NHI_ID_PREFIX}${organizationId}/${slug}`;
}

/** Parse a canonical nhi_id back into org + slug; `null` when not a valid nhi_id. */
export function parseNhiId(nhiId: string): { organization_id: string; slug: string } | null {
  if (!NHI_ID_PATTERN.test(nhiId)) return null;
  const [organizationId, slug] = nhiId.slice(NHI_ID_PREFIX.length).split('/');
  return { organization_id: organizationId, slug };
}

/** Active organization id: explicit > organization profile > 'default'. */
export function resolveAgentIdentityOrganizationId(organizationId?: string | null): string {
  const explicit = organizationId?.trim();
  if (explicit) return explicit;
  return loadOrganizationProfile()?.organization_id || 'default';
}

/**
 * Derive the canonical nhi_id for an agent slug without touching the ledger
 * (pure name derivation — used by team-role selection and staffing views).
 * Returns `null` when the slug or resolved org is not nhi-grammar-valid
 * (e.g. service ids like `service:stripe`).
 */
export function deriveAgentNhiId(slug: string, organizationId?: string | null): string | null {
  const org = resolveAgentIdentityOrganizationId(organizationId);
  if (!NHI_SLUG_PATTERN.test(org) || !NHI_SLUG_PATTERN.test(slug)) return null;
  return buildNhiId(org, slug);
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export const AGENT_IDENTITY_KINDS = ['agent', 'service'] as const;
export type AgentIdentityKind = (typeof AGENT_IDENTITY_KINDS)[number];

export const AGENT_IDENTITY_LIFECYCLE_STATUSES = [
  'provisioned',
  'active',
  'suspended',
  'retired',
] as const;
export type AgentIdentityLifecycleStatus = (typeof AGENT_IDENTITY_LIFECYCLE_STATUSES)[number];

const agentIdentityAffiliationSchema = z
  .object({
    organization_id: z.string(),
    /** Canonical tenant boundary; customer/{slug} is only a stance overlay. */
    tenant_slug: z.string().refine(isValidTenantSlug, 'invalid tenant slug').optional(),
    project_id: z.string().optional(),
    mission_id: z.string().optional(),
    task_id: z.string().optional(),
  })
  .strict();

export type AgentIdentityAffiliation = z.infer<typeof agentIdentityAffiliationSchema>;

const agentRuntimeInstanceSchema = z
  .object({
    /** In-memory runtime id — the `agent-registry` AgentRecord agentId. */
    instance_id: z.string(),
    pid: z.number().int().optional(),
    session_id: z.string().optional(),
    provider: z.string().optional(),
    model_id: z.string().optional(),
    bound_at: z.string(),
  })
  .strict();

export type AgentRuntimeInstanceBinding = z.infer<typeof agentRuntimeInstanceSchema>;

export const agentIdentityRecordSchema = z
  .object({
    nhi_id: z.string().regex(NHI_ID_PATTERN),
    kind: z.enum(AGENT_IDENTITY_KINDS),
    display_name: z.string(),
    accountable_human_id: z.string().min(1),
    affiliation: agentIdentityAffiliationSchema,
    lifecycle_status: z.enum(AGENT_IDENTITY_LIFECYCLE_STATUSES),
    provider_hint: z.string().optional(),
    model_hint: z.string().optional(),
    trust_ref: z.string().optional(),
    created_at: z.string(),
    retired_at: z.string().optional(),
    retire_reason: z.string().optional(),
    /** Live runtime instances currently bound to this identity (ephemeral). */
    runtime_instances: z.array(agentRuntimeInstanceSchema).optional(),
  })
  .strict();

export type AgentIdentityRecord = z.infer<typeof agentIdentityRecordSchema>;

// ---------------------------------------------------------------------------
// Journaled model: own kernel, own model name (never workerStateKernel)
// ---------------------------------------------------------------------------

export interface AgentIdentityState {
  /** Keyed by nhi_id. */
  identities: Record<string, AgentIdentityRecord>;
}

function initialAgentIdentityState(): AgentIdentityState {
  return { identities: {} };
}

/** NI-01's own kernel — deliberately not the shared `workerStateKernel` singleton. */
export const agentIdentityKernel = new EventSourcingKernel();

const agentIdentityModel = agentIdentityKernel.defineModel<AgentIdentityState>(
  'agent_identity',
  initialAgentIdentityState
);

/** op names as constants so callers/tests never guess the strings (KD-03 pattern). */
export const AGENT_IDENTITY_OPS = {
  identityProvisioned: 'identity_provisioned',
  identityActivated: 'identity_activated',
  identitySuspended: 'identity_suspended',
  identityRetired: 'identity_retired',
  instanceBound: 'instance_bound',
  instanceReleased: 'instance_released',
} as const;

const identityProvisionedPayloadSchema = z
  .object({
    nhi_id: z.string().regex(NHI_ID_PATTERN),
    kind: z.enum(AGENT_IDENTITY_KINDS),
    display_name: z.string(),
    accountable_human_id: z.string().min(1),
    affiliation: agentIdentityAffiliationSchema,
    provider_hint: z.string().optional(),
    model_hint: z.string().optional(),
    trust_ref: z.string().optional(),
    created_at: z.string(),
  })
  .strict();

const identityActivatedPayloadSchema = z
  .object({ nhi_id: z.string(), activated_at: z.string() })
  .strict();

const identitySuspendedPayloadSchema = z
  .object({ nhi_id: z.string(), suspended_at: z.string(), reason: z.string().optional() })
  .strict();

const identityRetiredPayloadSchema = z
  .object({ nhi_id: z.string(), retired_at: z.string(), retire_reason: z.string() })
  .strict();

const instanceBoundPayloadSchema = z
  .object({
    nhi_id: z.string(),
    instance_id: z.string(),
    pid: z.number().int().optional(),
    session_id: z.string().optional(),
    provider: z.string().optional(),
    model_id: z.string().optional(),
    bound_at: z.string(),
  })
  .strict();

const instanceReleasedPayloadSchema = z
  .object({
    nhi_id: z.string(),
    instance_id: z.string(),
    released_at: z.string(),
    reason: z.string().optional(),
  })
  .strict();

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.identityProvisioned, {
  model: agentIdentityModel,
  schema: identityProvisionedPayloadSchema,
  apply: (state, payload) => {
    // Idempotent: a duplicate provisioned event for a known nhi_id is a
    // no-op and MUST return the same reference (KD-03 purity contract).
    if (state.identities[payload.nhi_id]) return state;
    const record: AgentIdentityRecord = {
      nhi_id: payload.nhi_id,
      kind: payload.kind,
      display_name: payload.display_name,
      accountable_human_id: payload.accountable_human_id,
      affiliation: payload.affiliation,
      lifecycle_status: 'provisioned',
      created_at: payload.created_at,
      ...(payload.provider_hint ? { provider_hint: payload.provider_hint } : {}),
      ...(payload.model_hint ? { model_hint: payload.model_hint } : {}),
      ...(payload.trust_ref ? { trust_ref: payload.trust_ref } : {}),
    };
    return { identities: { ...state.identities, [record.nhi_id]: record } };
  },
});

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.identityActivated, {
  model: agentIdentityModel,
  schema: identityActivatedPayloadSchema,
  apply: (state, payload) => {
    const existing = state.identities[payload.nhi_id];
    if (!existing || existing.lifecycle_status === 'active') return state;
    // Retired is terminal: replay never resurrects a retired identity.
    if (existing.lifecycle_status === 'retired') return state;
    const activated: AgentIdentityRecord = { ...existing, lifecycle_status: 'active' };
    return { identities: { ...state.identities, [payload.nhi_id]: activated } };
  },
});

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.identitySuspended, {
  model: agentIdentityModel,
  schema: identitySuspendedPayloadSchema,
  apply: (state, payload) => {
    const existing = state.identities[payload.nhi_id];
    if (!existing || existing.lifecycle_status === 'suspended') return state;
    if (existing.lifecycle_status === 'retired') return state;
    const suspended: AgentIdentityRecord = { ...existing, lifecycle_status: 'suspended' };
    return { identities: { ...state.identities, [payload.nhi_id]: suspended } };
  },
});

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.identityRetired, {
  model: agentIdentityModel,
  schema: identityRetiredPayloadSchema,
  apply: (state, payload) => {
    const existing = state.identities[payload.nhi_id];
    if (!existing || existing.lifecycle_status === 'retired') return state;
    const retired: AgentIdentityRecord = {
      ...existing,
      lifecycle_status: 'retired',
      retired_at: payload.retired_at,
      retire_reason: payload.retire_reason,
    };
    // Retire implicitly releases any still-bound runtime instances: a retired
    // identity has no legitimate live runtime.
    delete retired.runtime_instances;
    return { identities: { ...state.identities, [payload.nhi_id]: retired } };
  },
});

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.instanceBound, {
  model: agentIdentityModel,
  schema: instanceBoundPayloadSchema,
  apply: (state, payload) => {
    const existing = state.identities[payload.nhi_id];
    if (!existing || existing.lifecycle_status === 'retired') return state;
    const instance: AgentRuntimeInstanceBinding = {
      instance_id: payload.instance_id,
      bound_at: payload.bound_at,
      ...(payload.pid !== undefined ? { pid: payload.pid } : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      ...(payload.provider ? { provider: payload.provider } : {}),
      ...(payload.model_id ? { model_id: payload.model_id } : {}),
    };
    const current = existing.runtime_instances || [];
    const priorIndex = current.findIndex((entry) => entry.instance_id === payload.instance_id);
    if (priorIndex >= 0 && JSON.stringify(current[priorIndex]) === JSON.stringify(instance)) {
      return state; // idempotent same-content re-bind
    }
    const nextInstances =
      priorIndex >= 0
        ? current.map((entry, index) => (index === priorIndex ? instance : entry))
        : [...current, instance];
    return {
      identities: {
        ...state.identities,
        [payload.nhi_id]: { ...existing, runtime_instances: nextInstances },
      },
    };
  },
});

agentIdentityKernel.defineOp(AGENT_IDENTITY_OPS.instanceReleased, {
  model: agentIdentityModel,
  schema: instanceReleasedPayloadSchema,
  apply: (state, payload) => {
    const existing = state.identities[payload.nhi_id];
    if (!existing) return state;
    const current = existing.runtime_instances || [];
    if (!current.some((entry) => entry.instance_id === payload.instance_id)) return state;
    const remaining = current.filter((entry) => entry.instance_id !== payload.instance_id);
    const next: AgentIdentityRecord = { ...existing };
    if (remaining.length > 0) next.runtime_instances = remaining;
    else delete next.runtime_instances;
    return { identities: { ...state.identities, [payload.nhi_id]: next } };
  },
});

// ---------------------------------------------------------------------------
// Journal: authoritative append-only JSONL + silent restore (SO-02 pattern)
// ---------------------------------------------------------------------------

/** On-disk schema version for THIS journal (independent of other journals). */
const AGENT_IDENTITY_JOURNAL_VERSION = 1;

export interface AgentIdentityJournalOptions {
  /** Authoritative append-only JSONL journal (resolved through secure-io/pathResolver). */
  journalPath: string;
  now?: () => string;
}

interface AgentIdentityReadResult {
  events: JournalEventEnvelope[];
  maxSeq: number;
}

export class AgentIdentityJournal {
  private readonly kernel = agentIdentityKernel;
  private readonly journalPath: string;
  private readonly now: () => string;
  private seqLoaded = false;
  private seq = 0;

  constructor(options: AgentIdentityJournalOptions) {
    this.journalPath = pathResolver.rootResolve(options.journalPath);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Validate, stamp seq/ts, and append. Refused during restore (no mutation while replaying). */
  append(opName: string, payload: unknown): JournalEventEnvelope {
    this.ensureSeqLoaded();
    const envelope = appendValidatedJournalEvent({
      kernel: this.kernel,
      opName,
      payload,
      journalPath: this.journalPath,
      seq: this.seq,
      now: this.now,
      buildEnvelope: ({ seq, ts, payload: validated }) =>
        journalEventEnvelopeSchema.parse({
          v: AGENT_IDENTITY_JOURNAL_VERSION,
          seq,
          ts,
          op: opName,
          payload: validated,
        }),
    });
    this.seq += 1;
    return envelope;
  }

  /** Reconstruct state purely from the journal: validate -> silent replay. No side effects. */
  restore(): AgentIdentityState {
    const read = this.readJournal();
    this.seq = read.maxSeq + 1;
    this.seqLoaded = true;
    return runInRestoreMode(() => {
      const states = this.kernel.project(read.events);
      return (states.get('agent_identity') as AgentIdentityState) ?? initialAgentIdentityState();
    });
  }

  private ensureSeqLoaded(): void {
    if (this.seqLoaded) return;
    this.seq = this.readJournal().maxSeq + 1;
    this.seqLoaded = true;
  }

  private readJournal(): AgentIdentityReadResult {
    if (!safeExistsSync(this.journalPath)) return { events: [], maxSeq: -1 };
    const raw = String(safeReadFile(this.journalPath, { encoding: 'utf-8' }));
    const events: JournalEventEnvelope[] = [];
    let maxSeq = -1;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = journalEventEnvelopeSchema.parse(JSON.parse(trimmed));
        events.push(parsed);
        if (parsed.seq > maxSeq) maxSeq = parsed.seq;
      } catch {
        // A torn/corrupt line must not poison replay of the rest.
      }
    }
    return { events, maxSeq };
  }
}

// ---------------------------------------------------------------------------
// Governed gate + error types
// ---------------------------------------------------------------------------

/**
 * Roles allowed to mutate the identity ledger.
 *
 * Chosen from the `resolveRole()` outcomes of the processes that actually
 * manage agent runtimes today (the `agentLifecycle.spawn` call chain):
 *   - `mission_controller` — scripts/mission_controller.ts + every mission
 *     orchestration path (`withExecutionContext('mission_controller', ...)`
 *     is the dominant governed-write context in libs/core).
 *   - `surface_runtime`   — scripts/agent_runtime_supervisor_daemon.ts sets
 *     `MISSION_ROLE=surface_runtime` and is the daemon that spawns agent
 *     runtimes for surfaces.
 *   - `orchestrator`      — resolveRole()'s procName heuristic for
 *     orchestrator processes (authority.ts).
 *   - `infrastructure_sentinel` — infra supervisors/watchdogs that restart
 *     runtimes (daemon_watchdog and runtime-supervision paths).
 *
 * Worker-role contexts (task workers spawning sub-agents) are deliberately
 * NOT allowlisted: delegated identity issuance becomes safe once NI-03's
 * delegation chains land. Until then, best-effort call sites (spawn wiring,
 * staffing) degrade to a logged warning instead of failing the operation.
 */
export const AGENT_IDENTITY_WRITE_ROLES = [
  'mission_controller',
  'surface_runtime',
  'orchestrator',
  'infrastructure_sentinel',
] as const;

export class AgentIdentityGovernedError extends Error {
  constructor(verb: string, resolvedRole: string | undefined) {
    super(
      `[agent-identity] '${verb}' requires an agent-runtime-managing execution context ` +
        `(one of: ${AGENT_IDENTITY_WRITE_ROLES.join(', ')}; resolved role: ` +
        `${resolvedRole ?? 'undefined'}). Call it from within ` +
        `withExecutionContext('mission_controller', ...) or from a process whose role ` +
        `resolves to an allowlisted role (see libs/core/authority.ts resolveRole).`
    );
    this.name = 'AgentIdentityGovernedError';
  }
}

export class AgentIdentityAccountabilityError extends Error {
  constructor(nhiId: string, kind: AgentIdentityKind) {
    super(
      `[agent-identity] identity ${nhiId} requires a non-empty accountable_human_id for ` +
        `kind '${kind}' (CO-06 invariant: every non-human identity has an accountable human).`
    );
    this.name = 'AgentIdentityAccountabilityError';
  }
}

export class AgentIdentityConflictError extends Error {
  constructor(
    public readonly nhiId: string,
    detail: string
  ) {
    super(`[agent-identity] identity ${nhiId} conflict: ${detail}`);
    this.name = 'AgentIdentityConflictError';
  }
}

export class AgentIdentityNotFoundError extends Error {
  constructor(public readonly nhiId: string) {
    super(`[agent-identity] identity ${nhiId} is not in the registry`);
    this.name = 'AgentIdentityNotFoundError';
  }
}

export class AgentIdentityLifecycleError extends Error {
  constructor(nhiId: string, detail: string) {
    super(`[agent-identity] identity ${nhiId}: ${detail}`);
    this.name = 'AgentIdentityLifecycleError';
  }
}

function assertAgentIdentityGovernedContext(verb: string): void {
  const role = resolveRole();
  if (!role || !(AGENT_IDENTITY_WRITE_ROLES as readonly string[]).includes(role)) {
    throw new AgentIdentityGovernedError(verb, role);
  }
}

// ---------------------------------------------------------------------------
// Service: module-level singleton journal, fresh replay on every read
// ---------------------------------------------------------------------------

/** Governed storage scope under active/shared/coordination/ (mission_controller write scope). */
export const AGENT_IDENTITY_JOURNAL_PATH = pathResolver.shared(
  'coordination/identity/agent-identities.jsonl'
);

let defaultJournal: AgentIdentityJournal | null = null;

/**
 * Hermetic-test guard: true once a test explicitly repointed the journal via
 * {@link resetAgentIdentityServiceForTests}. Under vitest, writes to the
 * governed DEFAULT path are refused unless a suite repointed first — the same
 * default-path-under-test discipline as provider-health-registry.ts
 * (`STATE_PATH_ENV`) and spend-guard.ts. Reads are always allowed.
 */
let journalExplicitlyScoped = false;

function getDefaultJournal(): AgentIdentityJournal {
  if (!defaultJournal) {
    defaultJournal = new AgentIdentityJournal({ journalPath: AGENT_IDENTITY_JOURNAL_PATH });
  }
  return defaultJournal;
}

/**
 * Project the current state fresh from the journal on EVERY access — no
 * in-memory cache (SO-02 review lesson: a stale cached projection could show
 * an identity as active after another process retired it). The journal is
 * small (identity lifecycle events only), so fresh read-and-replay per access
 * is cheap and always cross-process consistent.
 */
function ensureState(): AgentIdentityState {
  return getDefaultJournal().restore();
}

/**
 * Test-only hook: point the module-level singleton at a fresh journal path
 * (or the default governed path when omitted). Real callers never need this.
 */
export function resetAgentIdentityServiceForTests(
  journalPath: string = AGENT_IDENTITY_JOURNAL_PATH
): void {
  defaultJournal = new AgentIdentityJournal({ journalPath });
  journalExplicitlyScoped = journalPath !== AGENT_IDENTITY_JOURNAL_PATH;
}

function appendGoverned(opName: string, payload: unknown): void {
  if (process.env.VITEST && !journalExplicitlyScoped) {
    throw new Error(
      '[agent-identity] refusing to write the governed default journal under vitest — ' +
        'call resetAgentIdentityServiceForTests(<active/shared/tmp/... path>) in your suite ' +
        'setup (hermetic-test contract: tests never write the real active/ tree)'
    );
  }
  // Defense-in-depth: the caller-facing gate already required an allowlisted
  // runtime role, but re-assert `mission_controller` around the actual write
  // (mirroring orchestrator-session.ts) so the governed-path policy on
  // active/shared/coordination/ sees it too, regardless of which allowlisted
  // role the caller's own context was scoped to.
  withExecutionContext('mission_controller', () => {
    getDefaultJournal().append(opName, payload);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IssueAgentIdentityParams {
  kind: AgentIdentityKind;
  /** Org segment of the nhi_id. Omit to resolve from the organization profile ('default' fallback). */
  organizationId?: string;
  /** Slug segment of the nhi_id — same grammar as agent-manifest agentId. */
  slug: string;
  displayName?: string;
  accountableHumanId: string;
  affiliation?: Omit<AgentIdentityAffiliation, 'organization_id'>;
  providerHint?: string;
  modelHint?: string;
  trustRef?: string;
}

function coreParamsMatch(existing: AgentIdentityRecord, params: IssueAgentIdentityParams): boolean {
  const affiliation: AgentIdentityAffiliation = {
    organization_id: existing.affiliation.organization_id,
    ...(params.affiliation || {}),
  };
  return (
    existing.kind === params.kind &&
    existing.accountable_human_id === params.accountableHumanId &&
    existing.display_name === (params.displayName || params.slug) &&
    JSON.stringify(existing.affiliation) === JSON.stringify(affiliation)
  );
}

/**
 * Issue a new durable identity. Fails closed outside an allowlisted execution
 * context, on a missing `accountable_human_id` (agent/service kinds always
 * require one), and on invalid slug/org grammar.
 *
 * Uniqueness semantics: re-issuing an existing *non-retired* identity with
 * identical core params (kind, accountable human, display name, affiliation)
 * is idempotent and returns the existing record; differing params throw
 * {@link AgentIdentityConflictError}; a *retired* nhi_id can never be
 * re-issued (no NHI reuse — retire is terminal for that name).
 */
export function issueAgentIdentity(params: IssueAgentIdentityParams): AgentIdentityRecord {
  assertAgentIdentityGovernedContext('issueAgentIdentity');
  const organizationId = resolveAgentIdentityOrganizationId(params.organizationId);
  const nhiId = buildNhiId(organizationId, params.slug);
  if (params.affiliation?.tenant_slug && !isValidTenantSlug(params.affiliation.tenant_slug)) {
    throw new AgentIdentityFormatError(
      `invalid affiliation tenant slug "${params.affiliation.tenant_slug}"`
    );
  }
  if (!params.accountableHumanId?.trim()) {
    throw new AgentIdentityAccountabilityError(nhiId, params.kind);
  }

  const state = ensureState();
  const existing = state.identities[nhiId];
  if (existing) {
    if (existing.lifecycle_status === 'retired') {
      throw new AgentIdentityConflictError(
        nhiId,
        `retired at ${existing.retired_at} (${existing.retire_reason ?? 'no reason recorded'}); ` +
          'retired identities are never re-issued — mint a new slug instead'
      );
    }
    if (coreParamsMatch(existing, params)) return existing;
    throw new AgentIdentityConflictError(
      nhiId,
      'already issued with different core params (kind/accountable_human_id/display_name/affiliation)'
    );
  }

  const payload = {
    nhi_id: nhiId,
    kind: params.kind,
    display_name: params.displayName || params.slug,
    accountable_human_id: params.accountableHumanId,
    affiliation: { organization_id: organizationId, ...(params.affiliation || {}) },
    ...(params.providerHint ? { provider_hint: params.providerHint } : {}),
    ...(params.modelHint ? { model_hint: params.modelHint } : {}),
    ...(params.trustRef ? { trust_ref: params.trustRef } : {}),
    created_at: new Date().toISOString(),
  };
  appendGoverned(AGENT_IDENTITY_OPS.identityProvisioned, payload);
  const record = ensureState().identities[nhiId];
  if (!record) {
    throw new Error(`[agent-identity] internal: identity ${nhiId} missing after issue`);
  }
  return record;
}

/** Read-only, ungated: the identity for `nhiId`, or `null`. */
export function getAgentIdentity(nhiId: string): AgentIdentityRecord | null {
  return ensureState().identities[nhiId] ?? null;
}

export interface ListAgentIdentitiesFilter {
  kind?: AgentIdentityKind;
  lifecycle_status?: AgentIdentityLifecycleStatus;
  organization_id?: string;
  mission_id?: string;
  accountable_human_id?: string;
}

/** Read-only, ungated: all known identities (any status), oldest first. */
export function listAgentIdentities(filter?: ListAgentIdentitiesFilter): AgentIdentityRecord[] {
  let records = Object.values(ensureState().identities);
  if (filter?.kind) records = records.filter((record) => record.kind === filter.kind);
  if (filter?.lifecycle_status) {
    records = records.filter((record) => record.lifecycle_status === filter.lifecycle_status);
  }
  if (filter?.organization_id) {
    records = records.filter(
      (record) => record.affiliation.organization_id === filter.organization_id
    );
  }
  if (filter?.mission_id) {
    records = records.filter((record) => record.affiliation.mission_id === filter.mission_id);
  }
  if (filter?.accountable_human_id) {
    records = records.filter(
      (record) => record.accountable_human_id === filter.accountable_human_id
    );
  }
  return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function requireIdentity(nhiId: string): AgentIdentityRecord {
  const record = ensureState().identities[nhiId];
  if (!record) throw new AgentIdentityNotFoundError(nhiId);
  return record;
}

/** Governed. provisioned/suspended -> active. Idempotent when already active. Retired is terminal. */
export function activateAgentIdentity(nhiId: string): AgentIdentityRecord {
  assertAgentIdentityGovernedContext('activateAgentIdentity');
  const existing = requireIdentity(nhiId);
  if (existing.lifecycle_status === 'retired') {
    throw new AgentIdentityLifecycleError(nhiId, 'cannot activate a retired identity');
  }
  if (existing.lifecycle_status === 'active') return existing;
  appendGoverned(AGENT_IDENTITY_OPS.identityActivated, {
    nhi_id: nhiId,
    activated_at: new Date().toISOString(),
  });
  return requireIdentity(nhiId);
}

/** Governed. provisioned/active -> suspended. Idempotent when already suspended. Retired is terminal. */
export function suspendAgentIdentity(nhiId: string, reason?: string): AgentIdentityRecord {
  assertAgentIdentityGovernedContext('suspendAgentIdentity');
  const existing = requireIdentity(nhiId);
  if (existing.lifecycle_status === 'retired') {
    throw new AgentIdentityLifecycleError(nhiId, 'cannot suspend a retired identity');
  }
  if (existing.lifecycle_status === 'suspended') return existing;
  appendGoverned(AGENT_IDENTITY_OPS.identitySuspended, {
    nhi_id: nhiId,
    suspended_at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  });
  return requireIdentity(nhiId);
}

/** Governed. Any status -> retired (terminal). Idempotent when already retired. */
export function retireAgentIdentity(nhiId: string, reason: string): AgentIdentityRecord {
  assertAgentIdentityGovernedContext('retireAgentIdentity');
  const existing = requireIdentity(nhiId);
  if (existing.lifecycle_status === 'retired') return existing;
  appendGoverned(AGENT_IDENTITY_OPS.identityRetired, {
    nhi_id: nhiId,
    retired_at: new Date().toISOString(),
    retire_reason: reason,
  });
  return requireIdentity(nhiId);
}

export interface BindRuntimeInstanceParams {
  nhiId: string;
  /** In-memory runtime id — the agent-registry AgentRecord agentId. */
  instanceId: string;
  pid?: number;
  sessionId?: string;
  provider?: string;
  modelId?: string;
}

/**
 * Governed. Bind a live runtime instance to a durable identity; a provisioned
 * identity becomes active on its first instance binding. Suspended/retired
 * identities refuse new instances (fail-closed).
 */
export function bindRuntimeInstance(params: BindRuntimeInstanceParams): AgentIdentityRecord {
  assertAgentIdentityGovernedContext('bindRuntimeInstance');
  const existing = requireIdentity(params.nhiId);
  if (existing.lifecycle_status === 'retired') {
    throw new AgentIdentityLifecycleError(params.nhiId, 'cannot bind an instance: retired');
  }
  if (existing.lifecycle_status === 'suspended') {
    throw new AgentIdentityLifecycleError(params.nhiId, 'cannot bind an instance: suspended');
  }
  if (existing.lifecycle_status === 'provisioned') {
    appendGoverned(AGENT_IDENTITY_OPS.identityActivated, {
      nhi_id: params.nhiId,
      activated_at: new Date().toISOString(),
    });
  }
  appendGoverned(AGENT_IDENTITY_OPS.instanceBound, {
    nhi_id: params.nhiId,
    instance_id: params.instanceId,
    ...(params.pid !== undefined ? { pid: params.pid } : {}),
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.modelId ? { model_id: params.modelId } : {}),
    bound_at: new Date().toISOString(),
  });
  return requireIdentity(params.nhiId);
}

/**
 * Governed. Release a runtime instance. Idempotent: releasing an unknown
 * instance is a no-op; an unknown identity returns `null`. The identity
 * itself stays active until explicitly retired.
 */
export function releaseRuntimeInstance(
  nhiId: string,
  instanceId: string,
  reason?: string
): AgentIdentityRecord | null {
  assertAgentIdentityGovernedContext('releaseRuntimeInstance');
  const existing = ensureState().identities[nhiId];
  if (!existing) return null;
  if (!(existing.runtime_instances || []).some((entry) => entry.instance_id === instanceId)) {
    return existing;
  }
  appendGoverned(AGENT_IDENTITY_OPS.instanceReleased, {
    nhi_id: nhiId,
    instance_id: instanceId,
    released_at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  });
  return requireIdentity(nhiId);
}

// ---------------------------------------------------------------------------
// Resolve-or-issue helpers (spawn/staffing seams)
// ---------------------------------------------------------------------------

export interface EnsureAgentIdentityParams {
  slug: string;
  kind?: AgentIdentityKind;
  organizationId?: string;
  displayName?: string;
  /** Falls back to the organization profile's `accountable_human_resource_id`. */
  accountableHumanId?: string;
  affiliation?: Omit<AgentIdentityAffiliation, 'organization_id'>;
  providerHint?: string;
  modelHint?: string;
}

/**
 * Governed resolve-or-issue: return the existing identity for
 * `<org>/<slug>` regardless of its params/status, or issue a fresh
 * 'provisioned' one. Accountable human resolution: explicit param >
 * organization profile `accountable_human_resource_id`; if neither exists the
 * issue fails closed ({@link AgentIdentityAccountabilityError}).
 */
export function ensureAgentIdentityProvisioned(
  params: EnsureAgentIdentityParams
): AgentIdentityRecord {
  const organizationId = resolveAgentIdentityOrganizationId(params.organizationId);
  const nhiId = buildNhiId(organizationId, params.slug);
  const existing = getAgentIdentity(nhiId);
  if (existing) return existing;
  const accountableHumanId =
    params.accountableHumanId?.trim() ||
    loadOrganizationProfile()?.accountable_human_resource_id ||
    '';
  return issueAgentIdentity({
    kind: params.kind ?? 'agent',
    organizationId,
    slug: params.slug,
    displayName: params.displayName,
    accountableHumanId,
    affiliation: params.affiliation,
    providerHint: params.providerHint,
    modelHint: params.modelHint,
  });
}

export interface BestEffortAgentIdentityResult {
  /** Canonical nhi_id (derived even when the ledger write was refused), or null for an invalid slug. */
  nhi_id: string | null;
  /** The ledger record, when the resolve-or-issue actually reached the journal. */
  record: AgentIdentityRecord | null;
  /** True when the identity exists in the ledger (pre-existing or just issued). */
  recorded: boolean;
}

/**
 * Best-effort resolve-or-issue for runtime seams (agent-lifecycle spawn,
 * mission staffing): never throws. The canonical nhi_id is deterministic, so
 * it is still returned when the ledger write was refused (non-allowlisted
 * role) or failed (journal I/O) — the caller may stamp it as a name while the
 * ledger record is created later by a governed context; NI-02's warn-mode
 * actor verification surfaces any name that never got a ledger record.
 */
export function ensureAgentIdentityBestEffort(
  params: EnsureAgentIdentityParams
): BestEffortAgentIdentityResult {
  const nhiId = deriveAgentNhiId(params.slug, params.organizationId);
  if (!nhiId) {
    logger.warn(
      `[agent-identity] best-effort ensure skipped: "${params.slug}" is not a valid nhi slug`
    );
    return { nhi_id: null, record: null, recorded: false };
  }
  try {
    const record = ensureAgentIdentityProvisioned(params);
    return { nhi_id: record.nhi_id, record, recorded: true };
  } catch (error) {
    logger.warn(
      `[agent-identity] best-effort ensure for ${nhiId} did not reach the ledger: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { nhi_id: nhiId, record: null, recorded: false };
  }
}

/** Best-effort instance bind for spawn wiring: never throws, logs on failure. */
export function bindAgentRuntimeInstanceBestEffort(params: BindRuntimeInstanceParams): boolean {
  try {
    bindRuntimeInstance(params);
    return true;
  } catch (error) {
    logger.warn(
      `[agent-identity] best-effort instance bind ${params.instanceId} -> ${params.nhiId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

/** Best-effort instance release for shutdown wiring: never throws, logs on failure. */
export function releaseAgentRuntimeInstanceBestEffort(
  nhiId: string,
  instanceId: string,
  reason?: string
): void {
  try {
    releaseRuntimeInstance(nhiId, instanceId, reason);
  } catch (error) {
    logger.warn(
      `[agent-identity] best-effort instance release ${instanceId} -> ${nhiId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
