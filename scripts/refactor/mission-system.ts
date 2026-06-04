import {
  pathResolver,
  transitionStatus,
  syncProjectOperationalStateFromMission,
} from '@agent/core';
import { getCurrentBranch, getGitHash } from './mission-git.js';
import {
  createMission as _createMission,
  startMission as _startMission,
} from './mission-creation.js';
import {
  delegateMission as _delegateMission,
  finishMission as _finishMission,
  grantMissionAccess as _grantMissionAccess,
  grantMissionSudo as _grantMissionSudo,
  importMission as _importMission,
  verifyMission as _verifyMission,
} from './mission-lifecycle.js';
import {
  createCheckpoint as _createCheckpoint,
  purgeMissions as _purgeMissions,
  recordEvidence as _recordEvidence,
  recordTask as _recordTask,
  resumeMission as _resumeMission,
} from './mission-maintenance.js';
import {
  syncProjectLedger as _syncProjectLedger,
  syncProjectLedgerIfLinked as _syncProjectLedgerIfLinked,
} from './mission-project-ledger.js';
import { prewarmMissionTeam as _prewarmMissionTeam, showMissionTeam as _showMissionTeam, staffMissionTeam as _staffMissionTeam } from './mission-runtime.js';
import { distillMission as _distillMission } from './mission-distill.js';
import { dispatchMissionTickets as _dispatchMissionTickets } from './mission-ticket-dispatch.js';
import { dispatchMissionWorkItems as _dispatchMissionWorkItems } from './mission-workitem-dispatch.js';
import { sealMission as _sealMission } from './mission-seal.js';
import { loadState, saveState, readFocusedMissionId, writeFocusedMissionId } from './mission-state.js';

async function syncProjectOperationalStateIfLinked(missionId: string): Promise<void> {
  const state = loadState(missionId.toUpperCase());
  if (!state?.relationships?.project?.project_id) return;
  try {
    syncProjectOperationalStateFromMission({
      mission_id: state.mission_id,
      mission_type: state.mission_type,
      tier: state.tier,
      status: state.status,
      tenant_slug: state.tenant_slug,
      tenant_id: state.tenant_id,
      relationships: state.relationships,
      assigned_persona: state.assigned_persona,
      context: state.context,
      outcome_contract: state.outcome_contract,
    });
  } catch (err: any) {
    console.warn(`[project-state] sync skipped for ${state.mission_id}: ${err?.message || err}`);
  }
}

export function buildMissionSystem(rootDir = pathResolver.rootDir()) {
  const missionFocusPath = pathResolver.shared('runtime/current_mission_focus.json');
  const syncProjectLedgerIfLinkedInternal = async (missionId: string): Promise<void> =>
    _syncProjectLedgerIfLinked(missionId, rootDir);
  const syncProjectLedgerInternal = async (missionId: string): Promise<void> =>
    _syncProjectLedger(missionId, rootDir);
  const readFocusedMissionIdBound = () => readFocusedMissionId(missionFocusPath);
  const writeFocusedMissionIdBound = (missionId: string) => writeFocusedMissionId(missionFocusPath, missionId);

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
      });
      await syncProjectOperationalStateIfLinked(id);
    },
    delegateMission(id: string, agentId: string, a2aMessageId: string) {
      return _delegateMission(id, agentId, a2aMessageId, syncProjectLedgerIfLinkedInternal)
        .then(() => syncProjectOperationalStateIfLinked(id));
    },
    importMission(id: string, remoteUrl: string) {
      return _importMission(id, remoteUrl, transitionStatus as any, syncProjectLedgerIfLinkedInternal)
        .then(() => syncProjectOperationalStateIfLinked(id));
    },
    verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
      return _verifyMission(id, result, note, transitionStatus as any, syncProjectLedgerIfLinkedInternal)
        .then(() => syncProjectOperationalStateIfLinked(id));
    },
    finishMission(id: string, seal = false) {
      return _finishMission(id, seal, {
        archiveDir: pathResolver.active('archive/missions'),
        agentRuntimeEventPath: pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
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
      }).then(() => (explicitMissionId ? syncProjectOperationalStateIfLinked(explicitMissionId) : undefined));
    },
    resumeMission(id?: string) {
      return _resumeMission(id, {
        readFocusedMissionId: readFocusedMissionIdBound,
        writeFocusedMissionId: writeFocusedMissionIdBound,
        getCurrentBranch,
        syncProjectLedgerIfLinked: syncProjectLedgerIfLinkedInternal,
      }).then(() => (id ? syncProjectOperationalStateIfLinked(id) : Promise.resolve()));
    },
    recordTask(missionId: string, description: string, details: any = {}) {
      return _recordTask(missionId, description, details)
        .then(() => syncProjectOperationalStateIfLinked(missionId));
    },
    recordEvidence(
      missionId: string,
      taskId: string,
      note: string,
      evidence?: string[],
      teamRole?: string,
      actorId?: string,
      actorType?: 'agent' | 'human' | 'service',
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
    purgeMissions(dryRun = false) {
      return _purgeMissions(rootDir, dryRun);
    },
    showMissionTeam(id: string, refresh = false) {
      return _showMissionTeam(id, refresh, rootDir);
    },
    staffMissionTeam(id: string) {
      return _staffMissionTeam(id, rootDir).then(() => syncProjectOperationalStateIfLinked(id));
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
      },
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
        limit?: number;
        statuses?: Array<'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'>;
        sources?: Array<'local' | 'github' | 'jira' | 'peer'>;
        finalStatus?: 'review' | 'done';
      },
    ) {
      const state = loadState(id.toUpperCase());
      if (!state) {
        throw new Error(`Mission ${id.toUpperCase()} not found.`);
      }
      return _dispatchMissionWorkItems(state, options);
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
