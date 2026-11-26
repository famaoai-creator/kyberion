/**
 * Run-manifest binding — the trusted runner context that lets the external
 * operation gate admit a browser effect under a run-manifest charter
 * (pipeline-run-manifest-model.md §3.2).
 *
 * The runner installs `withRunManifestBinding` once per run and
 * `withRunManifestStep` around each leaf dispatch. Neither is ever hydrated
 * from action JSON. A missing or mismatched binding never denies anything: the
 * caller falls through to per-step approval with a debug reason.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../logger.js';
import { agentActor } from '../contracts/actor.js';
import { buildNhiId } from '../contracts/nhi-id.js';
import { isManifestBindableOperation } from '../foundation/authorization-registry.js';
import { computeRunManifestHash, type RunManifest } from '../pipeline/run-manifest.js';
import {
  findActiveCharter,
  hasRunManifestRunStarted,
  readCharterLedger,
  type CharterPathOptions,
} from './accountability-charter-registry.js';
import {
  RUN_MANIFEST_ACTION_CLASS,
  type Charter,
  type CharterManifestOperation,
} from './accountability-charter.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';
import {
  DEFAULT_RUN_PRINCIPAL_MODES,
  isRunPrincipalMode,
  parseRunManifestGrants,
  parseRunPrincipalModes,
  verifyManifestEntryMatchesEffect,
  type RunManifestGrant,
  type RunPrincipalMode,
} from './run-manifest-grant.js';

const logger = createLogger('run-manifest-binding');

/** Agent slug recorded as the executing actor of manifest-admitted effects. */
export const RUN_MANIFEST_AGENT_SLUG = 'pipeline-runner';

export interface RunManifestBindingInput {
  /** The manifest compiled from the file being run (same object passed to ensureRunManifestCharter). */
  manifest: RunManifest;
  /** Charter id returned by ensureRunManifestCharter; the active charter must still be this one. */
  charterId: string;
  /** Who runs this run (P3: run-principal). */
  principal: RunPrincipalMode;
  runId: string;
  /** Hermetic-test seam for the charter store root. */
  pathOptions?: CharterPathOptions;
}

export interface RunManifestStepInput {
  /** Step path in compileRunManifest's scheme ("3", "2.pipeline.0", "1.on_error.fallback.0"). */
  entryId: string;
  /** runtimeShapedAuthoredParams(operationId, step) of the unresolved step. */
  authoredParams?: Record<string, unknown>;
}

interface BindingState {
  readonly input: Readonly<RunManifestBindingInput>;
  /** Admission attempts per entry in this run: the occurrence bound counts every one. */
  readonly attempts: Map<string, number>;
  /** Effects this binding verified, for the gate's re-check (no second count). */
  readonly verified: WeakMap<object, { claim: CharterManifestOperation; occurrence: number }>;
  /**
   * Set once the run was found on the charter ledger (run_started, same UTC
   * day as that first check). Cached per binding so a run that crosses
   * midnight keeps its admission and no step re-reads the ledger.
   */
  runStartVerified: boolean;
  /**
   * When the runner installed the binding, right after recording the run.
   * Always the clock at install — never caller input: a caller-chosen date
   * could reuse a run id recorded on an earlier day and skip the daily cap.
   */
  readonly boundAt: Date;
}

/**
 * The runner records `run_started` and then installs the binding; allow this
 * much clock between the two when they straddle a UTC midnight.
 */
const RUN_START_RECORD_GRACE_MS = 60_000;

const bindingStore = new AsyncLocalStorage<BindingState>();
const stepStore = new AsyncLocalStorage<Readonly<RunManifestStepInput>>();

function invalidBinding(reason: string): never {
  throw new Error(
    `[RUN_MANIFEST_BINDING_INVALID] ${reason} | next: bind the manifest the runner compiled and the charter ensureRunManifestCharter returned`
  );
}

/** Install the run's manifest binding (runner only; once per run, outside every step). */
export function withRunManifestBinding<T>(input: RunManifestBindingInput, body: () => T): T {
  if (!input?.manifest || computeRunManifestHash(input.manifest) !== input.manifest.manifest_hash)
    invalidBinding('manifest body does not match its hash');
  if (!input.manifest.scope.tenant_slug) invalidBinding('manifest has no tenant scope');
  if (typeof input.charterId !== 'string' || !input.charterId.trim())
    invalidBinding('charter id is required');
  if (!isRunPrincipalMode(input.principal)) invalidBinding('principal must be attended|unattended');
  if (typeof input.runId !== 'string' || !input.runId.trim()) invalidBinding('run id is required');
  const frozen = Object.freeze({
    manifest: structuredClone(input.manifest),
    charterId: input.charterId,
    principal: input.principal,
    runId: input.runId,
    ...(input.pathOptions ? { pathOptions: { ...input.pathOptions } } : {}),
  });
  return bindingStore.run(
    {
      input: frozen,
      attempts: new Map(),
      verified: new WeakMap(),
      runStartVerified: false,
      boundAt: new Date(),
    },
    body
  );
}

/** Mark the leaf step being dispatched (runner only; around each leaf dispatch). */
export function withRunManifestStep<T>(input: RunManifestStepInput, body: () => T): T {
  if (typeof input?.entryId !== 'string' || !input.entryId.trim())
    invalidBinding('step entry id is required');
  return stepStore.run(
    Object.freeze({
      entryId: input.entryId,
      ...(input.authoredParams ? { authoredParams: structuredClone(input.authoredParams) } : {}),
    }),
    body
  );
}

/**
 * Run `body` with no manifest binding and no current step (runner only):
 * a nested run (`core:run_pipeline`) is not covered by its parent's manifest
 * and must never inherit its binding.
 */
export function withoutRunManifestBinding<T>(body: () => T): T {
  return bindingStore.exit(() => stepStore.exit(body));
}

/**
 * Run `body` with no current manifest step (runner only): a dispatch the
 * runner cannot place in the authored file (include fragment, tool call,
 * forwarded step) must never inherit an enclosing step's entry id.
 */
export function withoutRunManifestStep<T>(body: () => T): T {
  return stepStore.exit(body);
}

export function currentRunManifestBinding(): Readonly<RunManifestBindingInput> | undefined {
  return bindingStore.getStore()?.input;
}

export function currentRunManifestStep(): Readonly<RunManifestStepInput> | undefined {
  return stepStore.getStore();
}

export type RunManifestAdmission =
  { ok: true; charter: ApprovalGateCharterInput } | { ok: false; reason: string };

function grantFor(charter: Charter, entryId: string): RunManifestGrant | undefined {
  return parseRunManifestGrants(charter.envelope.manifest_operations)?.find(
    (grant) => grant.entry_id === entryId
  );
}

/**
 * Charter evidence for one effect, when the run's manifest charter covers it.
 * Every check failing returns a reason; the caller then uses per-step approval.
 */
export function resolveRunManifestCharterAuthority(
  facts: { operationId: string; effect: Record<string, unknown> },
  trustedTenant: string | undefined,
  now: Date = new Date()
): RunManifestAdmission {
  const state = bindingStore.getStore();
  if (!state) return { ok: false, reason: 'no run-manifest binding' };
  const step = stepStore.getStore();
  if (!step) return { ok: false, reason: 'no current manifest step' };
  const { manifest, charterId, principal, pathOptions } = state.input;
  if (!isManifestBindableOperation(facts.operationId))
    return { ok: false, reason: `${facts.operationId} is not manifest-bindable` };
  const tenant = manifest.scope.tenant_slug!;
  if (!trustedTenant || trustedTenant !== tenant)
    return { ok: false, reason: 'trusted tenant differs from the manifest tenant' };
  let charter: Charter | null;
  try {
    charter = findActiveCharter(
      { kind: 'run_manifest', tenant_slug: tenant, manifest_hash: manifest.manifest_hash },
      now,
      pathOptions
    );
  } catch (error) {
    return {
      ok: false,
      reason: `run-manifest charter unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!charter || charter.charter_id !== charterId)
    return { ok: false, reason: 'bound run-manifest charter is not the active one' };
  // The daily run cap is enforced where the run is recorded
  // (recordRunManifestRunStarted); a binding whose run was not recorded there
  // on the UTC day the binding was installed (or today) did not pass that cap
  // and admits nothing. Checking the install day keeps a run recorded at
  // 23:59 whose first external step comes after midnight pre-approved.
  if (!state.runStartVerified) {
    let started: boolean;
    try {
      const boundAt = state.boundAt.getTime();
      started =
        hasRunManifestRunStarted(charter, state.input.runId, state.boundAt, pathOptions) ||
        hasRunManifestRunStarted(charter, state.input.runId, now, pathOptions) ||
        // Recorded just before a binding installed across midnight.
        readCharterLedger(charter, pathOptions).some((entry) => {
          if (entry.kind !== 'run_started' || entry.run_id !== state.input.runId) return false;
          const recorded = Date.parse(String(entry.ts));
          return recorded <= boundAt && recorded >= boundAt - RUN_START_RECORD_GRACE_MS;
        });
    } catch (error) {
      return {
        ok: false,
        reason: `run-manifest ledger unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!started)
      return {
        ok: false,
        reason: `run ${state.input.runId} is not recorded on charter ${charterId} on the UTC day it was bound; the daily run cap was not checked`,
      };
    state.runStartVerified = true;
  }
  const modes = parseRunPrincipalModes(
    charter.envelope.principal_modes ?? DEFAULT_RUN_PRINCIPAL_MODES
  );
  if (!modes?.includes(principal))
    return { ok: false, reason: `run principal '${principal}' not approved` };
  const grant = grantFor(charter, step.entryId);
  if (!grant) return { ok: false, reason: `step ${step.entryId} has no manifest grant` };
  // Every admission attempt of the entry counts toward its occurrence bound.
  const occurrence = (state.attempts.get(step.entryId) ?? 0) + 1;
  state.attempts.set(step.entryId, occurrence);
  const verdict = verifyManifestEntryMatchesEffect(grant, facts.effect, {
    operationId: facts.operationId,
    occurrence,
    ...(step.authoredParams ? { authoredParams: step.authoredParams } : {}),
  });
  if ('reason' in verdict) return { ok: false, reason: verdict.reason };
  const claim: CharterManifestOperation = {
    manifest_hash: manifest.manifest_hash,
    entry_id: step.entryId,
    operation_id: facts.operationId,
    principal_mode: principal,
  };
  state.verified.set(facts.effect, { claim, occurrence });
  return {
    ok: true,
    charter: {
      scope: charter.scope,
      action: {
        actor: agentActor(
          buildNhiId(tenant, null, RUN_MANIFEST_AGENT_SLUG),
          charter.accountable.actor
        ),
        action_class: RUN_MANIFEST_ACTION_CLASS,
        manifest_operation: claim,
        data: { tier: 'confidential', tenant_slug: tenant, mode: 'read' },
        reversible: false,
        irreversible_action_name: facts.operationId,
        estimated_loss: 0,
        reputational_class: 'B',
        blast_radius: { recipients: 0, systems: 1 },
      },
      ...(pathOptions ? { pathOptions: { ...pathOptions } } : {}),
    },
  };
}

/**
 * Gate-side re-check (no second occurrence count): this exact effect object
 * was verified by the current binding for this exact claim, and still matches
 * the persisted grant.
 */
export function isRunManifestAdmissionVerified(
  operationId: string,
  effect: Record<string, unknown>,
  charter: ApprovalGateCharterInput
): boolean {
  const state = bindingStore.getStore();
  const step = stepStore.getStore();
  const claim = charter.action.manifest_operation;
  const verified = state?.verified.get(effect);
  if (!state || !step || !claim || !verified) return false;
  if (
    charter.scope.kind !== 'run_manifest' ||
    charter.scope.manifest_hash !== state.input.manifest.manifest_hash ||
    claim.entry_id !== step.entryId ||
    claim.operation_id !== operationId ||
    JSON.stringify(verified.claim) !== JSON.stringify(claim)
  )
    return false;
  let active: Charter | null;
  try {
    active = findActiveCharter(charter.scope, new Date(), state.input.pathOptions);
  } catch {
    return false;
  }
  const grant = active ? grantFor(active, claim.entry_id) : undefined;
  if (!grant || active!.charter_id !== state.input.charterId) return false;
  const verdict = verifyManifestEntryMatchesEffect(grant, effect, {
    operationId,
    occurrence: verified.occurrence,
    ...(step.authoredParams ? { authoredParams: step.authoredParams } : {}),
  });
  if ('reason' in verdict) {
    logger.debug(`[run-manifest] gate re-check failed — ${verdict.reason}`);
    return false;
  }
  return true;
}
