/**
 * scripts/refactor/mission-controller-routing-context.ts
 * Routing context contract for the Mission Controller CLI.
 */

import type { TaskEvidenceBinding } from '@agent/core/mission/mission-task-evidence-binding';
import type { HumanDecidedBy } from '@agent/core/mission/mission-types';
import type { getOptionValue, parseCsvOption } from './mission-cli-args.js';

export type Awaitable<T> = T | Promise<T>;
export type Print = (value: unknown) => void;

export interface MissionControllerRoutingContext {
  argv: string[];
  print?: Print;
  action?: string;
  arg1?: string;
  arg2?: string;
  arg3?: string;
  arg4?: string;
  arg5?: string;
  arg6?: string;
  arg7?: string;
  hasRefresh: boolean;
  hasDryRun: boolean;
  getOptionValue: typeof getOptionValue;
  parseCsvOption: typeof parseCsvOption;
  validateMissionStartCreateInput: (
    actionName: 'create' | 'start' | 'kickoff',
    missionId?: string,
    argv?: string[]
  ) => {
    tier?: 'personal' | 'confidential' | 'public';
    tenantId?: string;
    organizationId?: string;
    tenantSlug?: string;
    missionType?: string;
    visionRef?: string;
    persona?: string;
    relationships?: any;
    routingDecision?: string;
    ledgerTargets?: {
      markdown: string;
      json: string;
    };
  };
  createMission: (
    id: string,
    tier?: 'personal' | 'confidential' | 'public',
    tenantId?: string,
    missionType?: string,
    visionRef?: string,
    persona?: string,
    relationships?: any,
    tenantSlug?: string,
    organizationId?: string,
    options?: { ephemeral?: boolean; intentGoal?: string }
  ) => Awaitable<void>;
  startMission: (
    id: string,
    tier?: 'personal' | 'confidential' | 'public',
    persona?: string,
    tenantId?: string,
    missionType?: string,
    visionRef?: string,
    relationships?: any,
    tenantSlug?: string,
    organizationId?: string,
    options?: {
      ephemeral?: boolean;
      intentGoal?: string;
      force?: boolean;
      decidedBy?: HumanDecidedBy;
      admissionWorkItem?: string;
    }
  ) => Awaitable<void>;
  pauseMission: (id: string, note?: string, decidedBy?: HumanDecidedBy) => Awaitable<void>;
  cancelMission: (id: string, note?: string, decidedBy?: HumanDecidedBy) => Awaitable<void>;
  repairLegacyMissionState: (id: string, note?: string) => Awaitable<void>;
  prepareSourceWorkspace?: (
    missionId: string,
    taskId: string,
    baselineCommit: string
  ) => Awaitable<unknown>;
  recordRoutingDecisionInMissionState: (
    missionId: string,
    routingDecision: Record<string, unknown> | null,
    event: 'CREATE' | 'START'
  ) => Awaitable<void>;
  grantMissionAccess: (missionId: string, serviceId: string, ttl?: number) => Awaitable<void>;
  grantMissionSudo: (missionId: string, on?: boolean, ttl?: number) => Awaitable<void>;
  createCheckpoint: (taskId: string, note: string, explicitMissionId?: string) => Awaitable<void>;
  approveScopeChange: (
    id: string,
    options?: {
      approvedBy?: string;
      reason?: string;
      goalSummary?: string;
      successCondition?: string;
      approvalRequestId?: string;
    }
  ) => Awaitable<void>;
  requestMissionScopeApproval: (
    id: string,
    options?: {
      goalSummary?: string;
      reason?: string;
      successCondition?: string;
      requestedBy?: string;
    }
  ) => Awaitable<unknown>;
  triageMission: (
    id: string,
    options?: {
      json?: boolean;
      requestApproval?: boolean;
      goal?: string;
      reason?: string;
      successCondition?: string;
      requestedBy?: string;
    }
  ) => Awaitable<unknown>;
  delegateMission: (id: string, agentId: string, a2aMessageId: string) => Awaitable<void>;
  importMission: (id: string, remoteUrl: string) => Awaitable<void>;
  verifyMission: (id: string, result: 'verified' | 'rejected', note: string) => Awaitable<void>;
  distillMission: (id: string) => Awaitable<void>;
  dispatchMissionTickets: (
    id: string,
    options?: {
      targets?: Array<'workitem' | 'github' | 'jira'>;
      liveTargets?: Array<'workitem' | 'github' | 'jira'>;
      github?: { owner?: string; repo?: string };
      jira?: { domain?: string; projectKey?: string };
    }
  ) => Awaitable<void>;
  dispatchMissionWorkItems: (
    id: string,
    options?: {
      mode?: 'auto' | 'agent' | 'subagent';
      limit?: number;
      statuses?: Array<
        'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'
      >;
      sources?: Array<'local' | 'github' | 'jira' | 'peer'>;
      finalStatus?: 'review' | 'done';
    }
  ) => Awaitable<void>;
  sealMission: (id: string) => Awaitable<unknown>;
  enqueueMission: (
    id: string,
    tier: 'personal' | 'confidential' | 'public',
    priority: number,
    deps: string[]
  ) => Awaitable<void>;
  dispatchNextMission: () => Awaitable<void>;
  acceptRubricOverride: (
    id: string,
    reason?: string,
    severity?: string,
    print?: Print
  ) => Awaitable<void>;
  listMemoryQueue: (
    filterStatus?: 'queued' | 'approved' | 'rejected' | 'promoted',
    print?: Print
  ) => Awaitable<void>;
  showMemoryReview: (
    candidateId: string,
    tenantSlug?: string,
    jsonOutput?: boolean,
    print?: Print
  ) => Awaitable<void>;
  approveMemoryCandidate: (
    candidateId: string,
    note?: string,
    tenantSlug?: string,
    knowledgeDomain?: import('@agent/core/knowledge/memory-promotion-queue').MemoryKnowledgeDomain,
    ownerNhi?: string,
    curationJson?: string,
    decidedBy?: HumanDecidedBy,
    approvalChannel?: string,
    print?: Print,
    approvalOptions?: { requestApproval?: boolean; approvalRef?: string }
  ) => Awaitable<void>;
  rejectMemoryCandidate: (
    candidateId: string,
    note?: string,
    tenantSlug?: string,
    allDuplicates?: boolean,
    decidedBy?: HumanDecidedBy,
    print?: Print
  ) => Awaitable<void>;
  promoteMemoryCandidate: (
    candidateId: string,
    executionRole?: 'mission_controller' | 'chronos_gateway',
    note?: string,
    supersedes?: string,
    tenantSlug?: string,
    targetRoot?: string,
    print?: Print
  ) => Awaitable<void>;
  promotePendingMemoryCandidates: (
    input: {
      executionRole?: 'mission_controller' | 'chronos_gateway';
      dryRun?: boolean;
      note?: string;
      supersedes?: string;
      targetRoot?: string;
      missionId?: string;
    },
    print?: Print
  ) => Awaitable<void>;
  finishMission: (id: string, seal?: boolean) => Awaitable<void>;
  resumeMission: (id?: string) => Awaitable<void>;
  recordTask: (missionId: string, description: string, details?: any) => Awaitable<void>;
  recordEvidence: (
    missionId: string,
    taskId: string,
    note: string,
    evidence?: string[],
    teamRole?: string,
    actorId?: string,
    actorType?: 'agent' | 'human' | 'service',
    provider?: string,
    taskBinding?: TaskEvidenceBinding
  ) => Awaitable<void>;
  recordArtifactReview: (
    missionId: string,
    reviewTaskId: string,
    reviewerAgentId: string,
    findings?: unknown[],
    reviewerTeamRole?: 'reviewer' | 'qa',
    specialistRoles?: string[],
    provider?: string
  ) => Awaitable<unknown>;
  reconcileExistingWork: (
    missionId: string,
    manifestPath: string,
    dryRun?: boolean,
    approvalRequestId?: string
  ) => Awaitable<unknown>;
  requestMissionWorkReconciliationApproval: (
    missionId: string,
    manifestPath: string,
    requestedBy?: string
  ) => Awaitable<unknown>;
  requestMissionTaskSupersedeApproval: (input: {
    missionId: string;
    taskId: string;
    byTaskId: string;
    reason: string;
    requestedBy?: string;
  }) => Awaitable<unknown>;
  supersedeMissionTask: (input: {
    missionId: string;
    taskId: string;
    byTaskId: string;
    reason: string;
    dryRun: boolean;
    approvalRequestId?: string;
  }) => Awaitable<unknown>;
  reenterMissionFromReview: (missionId: string) => Awaitable<unknown>;
  purgeMissions: (dryRun?: boolean) => Awaitable<void>;
  archiveMissions: (options: { missionId?: string; execute?: boolean }) => Awaitable<void>;
  listMissions: (filterStatus?: string, jsonOutput?: boolean) => Awaitable<void>;
  listOrganizationCatalogs: (
    organizationId?: string,
    jsonOutput?: boolean,
    print?: Print
  ) => Awaitable<void>;
  listOrganizationProfiles: (organizationId?: string, print?: Print) => Awaitable<void>;
  showOrganizationProfile: (
    organizationId?: string,
    summaryOnly?: boolean,
    jsonOutput?: boolean,
    print?: Print
  ) => Awaitable<void>;
  showOrganizationDiscovery: (
    jsonOutput?: boolean,
    summaryOnly?: boolean,
    print?: Print
  ) => Awaitable<void>;
  showMissionStatus: (id: string, follow?: boolean) => Awaitable<void>;
  showReasoningBackendStatus: () => void | Promise<void>;
  syncProjectLedger: (missionId: string) => Awaitable<unknown>;
  reassignMissionProject: (
    missionId: string,
    options: {
      projectId?: string;
      projectPath?: string;
      tier?: 'personal' | 'confidential' | 'public';
      trackId?: string;
      trackName?: string;
      relationshipType?: 'belongs_to' | 'supports' | 'governs' | 'independent';
      note?: string;
      force?: boolean;
      dryRun?: boolean;
    }
  ) => Awaitable<unknown>;
  showMissionTeam: (
    id: string,
    refresh?: boolean,
    organizationId?: string,
    providerPreference?: { provider: string; modelId?: string }
  ) => Awaitable<unknown>;
  staffMissionTeam: (
    id: string,
    organizationId?: string,
    providerPreference?: { provider: string; modelId?: string }
  ) => Awaitable<unknown>;
  prewarmMissionTeam: (
    id: string,
    teamRolesArg?: string,
    organizationId?: string
  ) => Awaitable<unknown>;
  adviseMission: (
    id: string,
    input: { topic: string; question: string; context?: string; roles?: string[] },
    organizationId?: string
  ) => Awaitable<unknown>;
  proposeMissionRoster: (
    id: string,
    options: { missionContext?: string; force?: boolean },
    organizationId?: string
  ) => Awaitable<unknown>;
  restaffMissionTeam: (
    id: string,
    teamRole: string,
    options: { requiredCapabilities?: string[]; excludeAgentIds?: string[]; reason?: string },
    organizationId?: string
  ) => Awaitable<unknown>;
  classifyMission: (id: string, intentId?: string, taskType?: string) => Awaitable<void>;
  selectMissionWorkflow: (id: string, intentId?: string, taskType?: string) => Awaitable<void>;
  planProcessTemplateTasks: (args: {
    id: string;
    force?: boolean;
    refreshCatalog?: boolean;
  }) => Awaitable<void>;
  reviewWorkerOutput: (
    id: string,
    result?: 'verified' | 'rejected',
    note?: string
  ) => Awaitable<void>;
  handoffMission: (id: string, nextPersona: string, note?: string) => Awaitable<void>;
  gatePass: (missionId: string, gateId: string, note?: string) => Awaitable<void>;
  gateFail: (missionId: string, gateId: string, note?: string) => Awaitable<void>;
  showHelp: () => void;
}

export type MissionStartCreateInput = ReturnType<
  MissionControllerRoutingContext['validateMissionStartCreateInput']
>;
