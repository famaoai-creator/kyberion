/**
 * SO-01: in-process governed facade over the mission lifecycle verbs.
 *
 * `missionSystem` (mission-system.ts, buildMissionSystem) has always exposed
 * these verbs programmatically, but only `scripts/mission_controller.ts`
 * (the CLI) ever called them — build dependency direction (libs → scripts
 * is not allowed) kept any in-process/surface caller from reaching them
 * without shelling out to the compiled CLI. Moving the mission-* cluster
 * into libs/core (this package) removes that constraint; this module is the
 * governed entry point in-process callers use instead of reaching into
 * `missionSystem` directly.
 *
 * Every MUTATING verb enforces two things uniformly, regardless of caller:
 *   1. fail-closed execution-context gate — `resolveRole() === 'mission_controller'`
 *      (or an ancestor `withExecutionContext('mission_controller', ...)`
 *      frame), otherwise it throws. The CLI already runs under this role
 *      (`resolveRole()` infers it from the process argv[1] basename), so
 *      routing the CLI through this facade is transparent.
 *   2. exactly one `auditChain.record` per verb invocation, with a
 *      metadata shape of `{ actor, surface, verb, mission }` — identical
 *      whether the call came from the CLI or from an in-process surface.
 *      `surface` is a caller-supplied tag (default `'cli'`).
 *
 * `status` is read-only and exempt from both — it never mutates mission
 * state, so gating/auditing it would only add noise.
 */
import { buildMissionSystem, missionSystem } from './mission-system.js';
import { resolveRole } from './authority.js';
import { auditChain } from './audit-chain.js';
import { buildMissionStatusView, listMissionSummaries } from './mission-read-model.js';
import type { MissionStatusView, MissionSummary } from './mission-read-model.js';
import { releaseOrchestratorSessionForMissionBestEffort } from './orchestrator-session.js';
import { archiveMissionById } from './mission-maintenance.js';
import type { ArchiveMissionByIdResult, PurgeMissionsResult } from './mission-maintenance.js';
import type { MissionExecutionSurface } from './mission-execution-surface.js';

export interface MissionLifecycleVerbOptions {
  /**
   * Caller-supplied tag identifying which surface issued the call (e.g.
   * `'cli'`, `'slack'`, `'terminal'`). Defaults to `'cli'` — the CLI is
   * still the only caller today, so an unlabeled call is assumed to be it.
   */
  surface?: string;
}

export class MissionLifecycleGovernedError extends Error {
  constructor(verb: string, resolvedRole: string | undefined) {
    super(
      `[mission-lifecycle-service] verb '${verb}' requires mission_controller execution context ` +
        `(resolved role: ${resolvedRole ?? 'undefined'}). Call it from within ` +
        `withExecutionContext('mission_controller', ...) or from a process whose argv[1] resolves ` +
        `to mission_controller (see libs/core/authority.ts resolveRole).`
    );
    this.name = 'MissionLifecycleGovernedError';
  }
}

function assertMissionControllerContext(verb: string): void {
  const role = resolveRole();
  if (role !== 'mission_controller') {
    throw new MissionLifecycleGovernedError(verb, role);
  }
}

function resolveActor(): string {
  return process.env.KYBERION_PERSONA || process.env.MISSION_ROLE || 'mission_controller';
}

/**
 * Records the single facade-owned audit entry for a mutating verb. Shape is
 * fixed to `{ actor, surface, verb, mission }` so CLI-context and
 * in-process/surface-context calls are indistinguishable in the audit log
 * except for their actual values.
 */
function recordVerbAudit(verb: string, missionId: string | null, surface: string): void {
  const actor = resolveActor();
  auditChain.record({
    agentId: actor,
    action: 'mission.lifecycle_verb',
    operation: `${verb}:${missionId ?? 'unscoped'}`,
    result: 'completed',
    metadata: { actor, surface, verb, mission: missionId },
  });
}

function runGovernedVerb<T>(
  verb: string,
  missionId: string | null,
  options: MissionLifecycleVerbOptions | undefined,
  fn: () => Promise<T>
): Promise<T> {
  assertMissionControllerContext(verb);
  const surface = options?.surface || 'cli';
  return fn().then((result) => {
    recordVerbAudit(verb, missionId, surface);
    return result;
  });
}

function normalizeMissionId(id: string | undefined | null): string | null {
  return id ? id.toUpperCase() : null;
}

/**
 * Read-only — exempt from the execution-context gate and the shared audit
 * record (see module docstring): it never mutates mission state. Overloaded
 * so callers passing a definite mission id get `MissionStatusView | null`
 * (mirroring `buildMissionStatusView`) instead of the wider union.
 */
function missionLifecycleStatus(id: string): MissionStatusView | null;
function missionLifecycleStatus(id?: undefined): MissionSummary[];
function missionLifecycleStatus(id?: string): MissionStatusView | MissionSummary[] | null {
  if (!id) return listMissionSummaries();
  return buildMissionStatusView(id);
}

export interface MissionLifecycleCreateOptions extends MissionLifecycleVerbOptions {
  ephemeral?: boolean;
  intentGoal?: string;
}

export interface MissionLifecycleStartOptions extends MissionLifecycleCreateOptions {
  force?: boolean;
}

export interface MissionLifecycleDispatchOptions extends MissionLifecycleVerbOptions {
  mode?: 'auto' | 'agent' | 'subagent';
  executionSurface?: MissionExecutionSurface;
  reviewExecutionSurface?: MissionExecutionSurface;
  limit?: number;
  statuses?: Array<
    'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'
  >;
  sources?: Array<'local' | 'github' | 'jira' | 'peer'>;
  finalStatus?: 'review' | 'done';
}

/**
 * The subset of `missionSystem` this facade actually wraps. Narrowed (rather
 * than the full `ReturnType<typeof buildMissionSystem>`) so tests can pass a
 * lightweight stub covering only these ten verbs instead of the entire
 * mission system surface — the facade's own logic (gate + audit) is what
 * SO-01 tests, not the underlying mission-* implementations (already
 * covered by their own suites).
 */
export type MissionLifecycleUnderlyingSystem = Pick<
  ReturnType<typeof buildMissionSystem>,
  | 'create'
  | 'start'
  | 'createCheckpoint'
  | 'verifyMission'
  | 'finishMission'
  | 'staffMissionTeam'
  | 'prewarmMissionTeam'
  | 'dispatchMissionWorkItems'
  | 'pauseMission'
  | 'resumeMission'
  | 'purgeMissions'
>;

export interface MissionLifecycleArchiveOptions extends MissionLifecycleVerbOptions {
  /**
   * Explicit operator targeting: archive this single completed/failed
   * mission now, regardless of age. Omit for the policy-driven sweep
   * (`purgeMissions`).
   */
  missionId?: string;
  /** Policy-driven sweep only: preview candidates without moving anything. */
  dryRun?: boolean;
}

/**
 * Governed facade instance bound to a specific mission root. Mirrors
 * `buildMissionSystem(rootDir)` but adds the fail-closed gate + shared audit
 * record described above. Most callers want the default singleton export
 * `missionLifecycleService` below; this factory exists for tests and any
 * caller that needs a non-default rootDir or a stub system (mirrors
 * `buildMissionSystem`).
 *
 * `system` deliberately has NO default value evaluated here (`= missionSystem`
 * would read the `missionSystem` binding the instant this factory runs). This
 * module is imported by `libs/core/index.ts`, and mission-system.ts's own
 * dependency graph transitively reaches back into the index barrel (e.g.
 * service-engine.ts imports `from './index.js'`) now that mission-ticket-
 * dispatch.ts / mission-workitem-dispatch.ts moved into libs/core — loading
 * `@agent/core/mission-system` in isolation therefore re-enters the barrel
 * mid-evaluation. Reading `missionSystem` eagerly at that point hits the
 * TDZ. Resolving it lazily inside each verb (see `resolveSystem` below)
 * defers the read until a verb is actually invoked, by which point the
 * module graph has finished loading.
 */
function resolveSystem(
  system?: MissionLifecycleUnderlyingSystem
): MissionLifecycleUnderlyingSystem {
  return system ?? missionSystem;
}

export function buildMissionLifecycleService(
  explicitSystem?: MissionLifecycleUnderlyingSystem,
  overrides?: {
    /** Test seam for the targeted single-mission archive implementation. */
    archiveMissionById?: typeof archiveMissionById;
  }
) {
  return {
    async create(
      id: string,
      tier: 'personal' | 'confidential' | 'public' = 'confidential',
      tenantId: string = 'default',
      missionType: string = 'development',
      visionRef?: string,
      persona: string = 'worker',
      relationships: any = {},
      tenantSlug?: string,
      options?: MissionLifecycleCreateOptions
    ) {
      return runGovernedVerb('create', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).create(
          id,
          tier,
          tenantId,
          missionType,
          visionRef,
          persona,
          relationships,
          tenantSlug,
          { ephemeral: options?.ephemeral, intentGoal: options?.intentGoal }
        )
      );
    },

    async start(
      id: string,
      tier: 'personal' | 'confidential' | 'public' = 'confidential',
      persona: string = 'worker',
      tenantId: string = 'default',
      missionType: string = 'development',
      visionRef?: string,
      relationships: any = {},
      tenantSlug?: string,
      options?: MissionLifecycleStartOptions
    ) {
      return runGovernedVerb('start', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).start(
          id,
          tier,
          persona,
          tenantId,
          missionType,
          visionRef,
          relationships,
          tenantSlug,
          {
            ephemeral: options?.ephemeral,
            intentGoal: options?.intentGoal,
            force: options?.force,
          }
        )
      );
    },

    async createCheckpoint(
      taskId: string,
      note: string,
      explicitMissionId?: string,
      options?: MissionLifecycleVerbOptions
    ) {
      return runGovernedVerb('checkpoint', normalizeMissionId(explicitMissionId), options, () =>
        resolveSystem(explicitSystem).createCheckpoint(taskId, note, explicitMissionId)
      );
    },

    async verify(
      id: string,
      result: 'verified' | 'rejected',
      note: string,
      options?: MissionLifecycleVerbOptions
    ) {
      return runGovernedVerb('verify', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).verifyMission(id, result, note)
      );
    },

    async finish(id: string, seal = false, options?: MissionLifecycleVerbOptions) {
      const result = await runGovernedVerb('finish', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).finishMission(id, seal)
      );
      // SO-02: a finished mission has nothing left to steer — release its
      // orchestrator session (if any). Best-effort: a release failure must
      // never fail the finish that already succeeded.
      releaseOrchestratorSessionForMissionBestEffort(normalizeMissionId(id), 'finish');
      return result;
    },

    async staff(id: string, options?: MissionLifecycleVerbOptions) {
      return runGovernedVerb('staff', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).staffMissionTeam(id)
      );
    },

    async prewarm(id: string, teamRolesArg?: string, options?: MissionLifecycleVerbOptions) {
      return runGovernedVerb('prewarm', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).prewarmMissionTeam(id, teamRolesArg)
      );
    },

    async dispatch(id: string, options?: MissionLifecycleDispatchOptions) {
      return runGovernedVerb('dispatch', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).dispatchMissionWorkItems(id, {
          mode: options?.mode,
          executionSurface: options?.executionSurface,
          reviewExecutionSurface: options?.reviewExecutionSurface,
          limit: options?.limit,
          statuses: options?.statuses,
          sources: options?.sources,
          finalStatus: options?.finalStatus,
        })
      );
    },

    /**
     * AL-03: governed archive verb. Without `missionId` it runs the
     * policy-driven sweep (`purgeMissions` — completed/aged missions per the
     * lifecycle ADF). With `missionId` it archives that single
     * completed/failed mission immediately regardless of age (explicit
     * operator action). Both paths are idempotent: re-archiving an
     * already-archived or missing mission returns a structured no-op.
     */
    async archive(
      options?: MissionLifecycleArchiveOptions
    ): Promise<ArchiveMissionByIdResult | PurgeMissionsResult> {
      const targeted = normalizeMissionId(options?.missionId);
      return runGovernedVerb('archive', targeted, options, async () => {
        if (targeted) {
          const archiveOne = overrides?.archiveMissionById ?? archiveMissionById;
          return archiveOne(targeted);
        }
        return resolveSystem(explicitSystem).purgeMissions(options?.dryRun ?? false);
      });
    },

    async pause(id: string, note?: string, options?: MissionLifecycleVerbOptions) {
      return runGovernedVerb('pause', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).pauseMission(id, note)
      );
    },

    async resume(id?: string, options?: MissionLifecycleVerbOptions) {
      return runGovernedVerb('resume', normalizeMissionId(id), options, () =>
        resolveSystem(explicitSystem).resumeMission(id)
      );
    },

    status: missionLifecycleStatus,
  };
}

export type MissionLifecycleService = ReturnType<typeof buildMissionLifecycleService>;

/** Default facade bound to the process-wide `missionSystem` singleton. */
export const missionLifecycleService: MissionLifecycleService = buildMissionLifecycleService();
