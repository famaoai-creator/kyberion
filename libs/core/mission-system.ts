import * as pathResolver from './path-resolver.js';
import { transitionStatus } from './mission-status.js';
import { type ArtifactReviewFinding } from './artifact-review.js';
import { getCurrentBranch, getGitHash } from './mission-git.js';
import {
  createMission as _createMission,
  startMission as _startMission,
} from './mission-creation.js';
import {
  delegateMission as _delegateMission,
  cancelMission as _cancelMission,
  repairLegacyMissionState as _repairLegacyMissionState,
  finishMission as _finishMission,
  grantMissionAccess as _grantMissionAccess,
  grantMissionSudo as _grantMissionSudo,
  importMission as _importMission,
  pauseMission as _pauseMission,
  reenterMissionFromReview as _reenterMissionFromReview,
  verifyMission as _verifyMission,
} from './mission-lifecycle.js';
import {
  approveScopeChange as _approveScopeChange,
  createCheckpoint as _createCheckpoint,
  purgeMissions as _purgeMissions,
  recordArtifactReview as _recordArtifactReview,
  recordEvidence as _recordEvidence,
  recordTask as _recordTask,
  resumeMission as _resumeMission,
} from './mission-maintenance.js';
import {
  syncProjectLedger as _syncProjectLedger,
  syncProjectLedgerIfLinked as _syncProjectLedgerIfLinked,
} from './mission-project-ledger.js';
import {
  prewarmMissionTeam as _prewarmMissionTeam,
  showMissionTeam as _showMissionTeam,
  staffMissionTeam as _staffMissionTeam,
} from './mission-runtime.js';
import { distillMission as _distillMission } from './mission-distill.js';
import { dispatchMissionTickets as _dispatchMissionTickets } from './mission-ticket-dispatch.js';
import { dispatchMissionWorkItems as _dispatchMissionWorkItems } from './mission-workitem-dispatch.js';
import type { MissionExecutionSurface } from './mission-execution-surface.js';
import { reconcileMissionExistingWork as _reconcileMissionExistingWork } from './mission-work-reconciliation.js';
import { sealMission as _sealMission } from './mission-seal.js';
import {
  loadState,
  saveState,
  readFocusedMissionId,
  writeFocusedMissionId,
} from './mission-state.js';
import { syncProjectOperationalStateIfLinked } from './project-state-sync.js';
import { ensureMissionTeamRuntimeViaSupervisor } from './agent-runtime-supervisor.js';
import {
  handoffWorkItem,
  listWorkItems,
  updateWorkItem,
  type HandoffWorkItemInput,
  type WorkItem,
} from './work-coordination.js';
import { appendCoordinationEvent } from './work-coordination.js';
import { buildWorkItemHandoffPacket } from './handoff-packet.js';

export function buildMissionSystem(rootDir = pathResolver.rootDir()) {
  const missionFocusPath = pathResolver.shared('runtime/current_mission_focus.json');
  const syncProjectLedgerIfLinkedInternal = async (missionId: string): Promise<void> =>
    _syncProjectLedgerIfLinked(missionId, rootDir);
  const syncProjectLedgerInternal = async (missionId: string): Promise<void> =>
    _syncProjectLedger(missionId, rootDir);
  const readFocusedMissionIdBound = () => readFocusedMissionId(missionFocusPath);
  const writeFocusedMissionIdBound = (missionId: string) =>
    writeFocusedMissionId(missionFocusPath, missionId);

  return {
    loadState,
    saveState,
    readFocusedMissionId: readFocusedMissionIdBound,
    writeFocusedMissionId: writeFocusedMissionIdBound,
    async create(
      id: string,
      tier: 'personal' | 'confidential' | 'public' = 'confidential',
      tenantId: string = 'default',
      missionType: string = 'development',
      visionRef?: string,
      persona: string = 'worker',
      relationships: any = {},
      tenantSlug?: string,
      /**
       * SO-01: explicit options replacing the old direct `process.argv`
       * reads inside mission-creation.ts. In-process callers get
       * deterministic defaults (both undefined/false) unless they pass
       * these explicitly; the CLI router parses `--ephemeral` /
       * `--intent-goal <path>` from argv and forwards them here.
       */
      options?: { ephemeral?: boolean; intentGoal?: string }
    ) {
      const result = await _createMission({
        id,
        tier,
        tenantId,
        ...(tenantSlug ? { tenantSlug } : {}),
        missionType,
        visionRef,
        persona,
        relationships,
        rootDir,
        ephemeral: options?.ephemeral,
        intentGoal: options?.intentGoal,
      });
      await syncProjectOperationalStateIfLinked(id);
      return result;
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
      /** SO-01: see `create` above. */
      options?: { ephemeral?: boolean; intentGoal?: string; force?: boolean }
    ) {
      await _startMission({
        id,
        tier,
        persona,
        tenantId,
        ...(tenantSlug ? { tenantSlug } : {}),
        missionType,
        visionRef,
        relationships,
        rootDir,
        force: options?.force,
        ephemeral: options?.ephemeral,
        intentGoal: options?.intentGoal,
      });
      await syncProjectOperationalStateIfLinked(id);
    },
    delegateMission(id: string, agentId: string, a2aMessageId: string) {
      return _delegateMission(id, agentId, a2aMessageId, syncProjectLedgerIfLinkedInternal).then(
        () => syncProjectOperationalStateIfLinked(id)
      );
    },
    importMission(id: string, remoteUrl: string) {
      return _importMission(
        id,
        remoteUrl,
        transitionStatus as any,
        syncProjectLedgerIfLinkedInternal
      ).then(() => syncProjectOperationalStateIfLinked(id));
    },
    verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
      return _verifyMission(
        id,
        result,
        note,
        transitionStatus as any,
        syncProjectLedgerIfLinkedInternal
      ).then(() => syncProjectOperationalStateIfLinked(id));
    },
    finishMission(id: string, seal = false) {
      return _finishMission(id, seal, {
        archiveDir: pathResolver.active('archive/missions'),
        agentRuntimeEventPath: pathResolver.shared(
          'observability/mission-control/agent-runtime-events.jsonl'
        ),
        getGitHash,
        sealMission: _sealMission,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
        transitionStatus: transitionStatus as any,
      }).then(() => syncProjectOperationalStateIfLinked(id));
    },
    createCheckpoint(taskId: string, note: string, explicitMissionId?: string) {
      return _createCheckpoint({
        taskId,
        note,
        explicitMissionId,
        readFocusedMissionId: readFocusedMissionIdBound,
        writeFocusedMissionId: writeFocusedMissionIdBound,
        getGitHash,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
      }).then(() =>
        explicitMissionId ? syncProjectOperationalStateIfLinked(explicitMissionId) : undefined
      );
    },
    approveScopeChange(
      id: string,
      options?: {
        approvedBy?: string;
        reason?: string;
        goalSummary?: string;
        successCondition?: string;
      }
    ) {
      return _approveScopeChange({
        missionId: id,
        approvedBy: options?.approvedBy,
        reason: options?.reason || 'Approved scope adjustment.',
        goalSummary: options?.goalSummary || '',
        successCondition: options?.successCondition,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
      }).then(() => syncProjectOperationalStateIfLinked(id));
    },
    resumeMission(id?: string) {
      return _resumeMission(id, {
        readFocusedMissionId: readFocusedMissionIdBound,
        writeFocusedMissionId: writeFocusedMissionIdBound,
        getCurrentBranch,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
      }).then(() => (id ? syncProjectOperationalStateIfLinked(id) : Promise.resolve()));
    },
    pauseMission(id: string, note?: string) {
      return _pauseMission(id, note).then(() => syncProjectOperationalStateIfLinked(id));
    },
    reenterMissionFromReview(id: string) {
      return _reenterMissionFromReview(id).then((result) =>
        syncProjectOperationalStateIfLinked(id).then(() => result)
      );
    },
    cancelMission(id: string, note?: string) {
      return _cancelMission(id, note).then(() => syncProjectOperationalStateIfLinked(id));
    },
    repairLegacyMissionState(id: string, note?: string) {
      return _repairLegacyMissionState(id, note).then(() =>
        syncProjectOperationalStateIfLinked(id)
      );
    },
    recordTask(missionId: string, description: string, details: any = {}) {
      return _recordTask(missionId, description, details).then(() =>
        syncProjectOperationalStateIfLinked(missionId)
      );
    },
    recordEvidence(
      missionId: string,
      taskId: string,
      note: string,
      evidence?: string[],
      teamRole?: string,
      actorId?: string,
      actorType?: 'agent' | 'human' | 'service'
    ) {
      return _recordEvidence({
        missionId,
        taskId,
        note,
        evidence,
        teamRole,
        actorId,
        actorType,
        getGitHash,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
      }).then(() => syncProjectOperationalStateIfLinked(missionId));
    },
    recordArtifactReview(
      missionId: string,
      reviewTaskId: string,
      reviewerAgentId: string,
      findings?: ArtifactReviewFinding[],
      reviewerTeamRole?: 'reviewer' | 'qa',
      specialistRoles?: string[]
    ) {
      return _recordArtifactReview({
        missionId,
        reviewTaskId,
        reviewerAgentId,
        findings,
        reviewerTeamRole,
        specialistRoles,
        getGitHash,
      }).then((result) => syncProjectOperationalStateIfLinked(missionId).then(() => result));
    },
    reconcileExistingWork(missionId: string, manifestPath: string, dryRun = false) {
      return _reconcileMissionExistingWork({ missionId, manifestPath, dryRun }).then((result) => {
        if (dryRun) return result;
        return syncProjectOperationalStateIfLinked(missionId).then(() => result);
      });
    },
    purgeMissions(dryRun = false) {
      return _purgeMissions(rootDir, dryRun);
    },
    showMissionTeam(id: string, refresh = false) {
      return _showMissionTeam(id, refresh, rootDir);
    },
    staffMissionTeam(id: string) {
      return _staffMissionTeam(id, rootDir).then((result) =>
        syncProjectOperationalStateIfLinked(id).then(() => result)
      );
    },
    prewarmMissionTeam(id: string, teamRolesArg?: string) {
      return _prewarmMissionTeam(id, teamRolesArg);
    },
    grantMissionAccess(missionId: string, serviceId: string, ttl = 30) {
      return _grantMissionAccess(missionId, serviceId, ttl);
    },
    grantMissionSudo(missionId: string, on = true, ttl = 15) {
      return _grantMissionSudo(missionId, on, ttl);
    },
    distillMission(id: string) {
      return _distillMission(id, rootDir).then(() => syncProjectOperationalStateIfLinked(id));
    },
    dispatchMissionTickets(
      id: string,
      options?: {
        targets?: Array<'workitem' | 'github' | 'jira'>;
        liveTargets?: Array<'workitem' | 'github' | 'jira'>;
        github?: { owner?: string; repo?: string };
        jira?: { domain?: string; projectKey?: string };
      }
    ) {
      const state = loadState(id.toUpperCase());
      if (!state) {
        throw new Error(`Mission ${id.toUpperCase()} not found.`);
      }
      return _dispatchMissionTickets(state, options);
    },
    dispatchMissionWorkItems(
      id: string,
      options?: {
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
    ) {
      const state = loadState(id.toUpperCase());
      if (!state) {
        throw new Error(`Mission ${id.toUpperCase()} not found.`);
      }
      return _dispatchMissionWorkItems(state, options);
    },
    /**
     * Expand a mission handoff over the canonical WorkItem ledger. NEXT_TASKS
     * is intentionally not consulted: unfinished WorkItems are the authority.
     * Runtime prewarming is best-effort and happens before lease transfer so a
     * missing receiver leaves the durable handoff packet recoverable.
     */
    async handoffMissionWorkItems(input: {
      missionId: string;
      fromPeerId: string;
      toPeerId: string;
      purpose: string;
      toUserId?: string;
      ttlMs?: number;
      correlationId?: string;
      metadata?: Record<string, unknown>;
      ensureRuntime?: boolean;
    }): Promise<{
      mission_id: string;
      handed_off: Array<ReturnType<typeof handoffWorkItem>>;
      skipped: WorkItem[];
      runtime_requested: boolean;
      runtime_error?: string;
    }> {
      const missionId = input.missionId.toUpperCase();
      const unfinished = listWorkItems().filter((item) => {
        const belongsToMission =
          item.project_id.toUpperCase() === missionId ||
          item.context?.mission_id?.toUpperCase() === missionId ||
          (typeof item.metadata?.mission_id === 'string' &&
            item.metadata.mission_id.toUpperCase() === missionId);
        return belongsToMission && !['done', 'archived'].includes(item.status);
      });
      let runtimeRequested = false;
      let runtimeError: string | undefined;
      if (input.ensureRuntime !== false) {
        // The governed ensure path is requested even when the supervisor cannot
        // satisfy it immediately. Keep this signal true so callers can
        // distinguish a requested-but-unavailable receiver from a disabled
        // prewarm path; the durable WorkItem handoff remains recoverable below.
        runtimeRequested = true;
        try {
          await ensureMissionTeamRuntimeViaSupervisor({
            missionId,
            requestedBy: 'mission_controller',
            reason: `Prepare receiving peer ${input.toPeerId} for mission handoff.`,
          });
        } catch (error) {
          runtimeError = error instanceof Error ? error.message : String(error);
          for (const item of unfinished) {
            if (!item.lease_id || item.claimed_by_peer_id !== input.fromPeerId) continue;
            const attemptId = item.attempts?.find(
              (attempt) => attempt.run_id === item.current_attempt_id
            )?.attempt_id;
            const packet = buildWorkItemHandoffPacket({
              itemId: item.item_id,
              itemTitle: item.title,
              purpose: input.purpose,
              fromPeerId: input.fromPeerId,
              toPeerId: input.toPeerId,
              correlationId: input.correlationId ?? item.item_id,
              ...(attemptId ? { attemptId } : {}),
              metadata: input.metadata,
            });
            const pendingHandoff = {
              packet,
              source_peer_id: input.fromPeerId,
              target_peer_id: input.toPeerId,
              retry_marker: `runtime-unavailable:${Date.now()}`,
              runtime_error: runtimeError,
            };
            updateWorkItem({
              itemId: item.item_id,
              expectedVersion: item.version,
              metadata: {
                ...(item.metadata || {}),
                pending_handoff: pendingHandoff,
              },
            });
            appendCoordinationEvent({
              eventType: 'handoff_written',
              itemId: item.item_id,
              leaseId: item.lease_id,
              actorPeerId: input.fromPeerId,
              note: `pending handoff packet written for ${item.item_id}`,
              payload: { pending_handoff: pendingHandoff },
            });
          }
          return {
            mission_id: missionId,
            handed_off: [],
            skipped: unfinished,
            runtime_requested: runtimeRequested,
            runtime_error: runtimeError,
          };
        }
      }

      const handedOff: Array<ReturnType<typeof handoffWorkItem>> = [];
      const skipped: WorkItem[] = [];
      for (const item of unfinished) {
        if (!item.lease_id || item.claimed_by_peer_id !== input.fromPeerId) {
          skipped.push(item);
          continue;
        }
        const handoffInput: HandoffWorkItemInput = {
          itemId: item.item_id,
          fromLeaseId: item.lease_id,
          fromPeerId: input.fromPeerId,
          toPeerId: input.toPeerId,
          ...(input.toUserId ? { toUserId: input.toUserId } : {}),
          purpose: input.purpose,
          ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
          expectedVersion: item.version,
          ...(item.metadata?.pending_handoff &&
          typeof item.metadata.pending_handoff === 'object' &&
          item.metadata.pending_handoff !== null &&
          'packet' in item.metadata.pending_handoff
            ? {
                handoffPacket: item.metadata.pending_handoff
                  .packet as HandoffWorkItemInput['handoffPacket'],
              }
            : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          metadata: input.metadata,
        };
        const completed = handoffWorkItem(handoffInput);
        handedOff.push(completed);
      }
      return {
        mission_id: missionId,
        handed_off: handedOff,
        skipped,
        runtime_requested: runtimeRequested,
        ...(runtimeError ? { runtime_error: runtimeError } : {}),
      };
    },
    sealMission(id: string) {
      return _sealMission(id);
    },
    syncProjectLedger(missionId: string) {
      return syncProjectLedgerInternal(missionId);
    },
    syncProjectLedgerIfLinked(missionId: string) {
      return syncProjectLedgerIfLinkedInternal(missionId);
    },
  };
}

export const missionSystem = buildMissionSystem();
