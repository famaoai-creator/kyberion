/**
 * scripts/refactor/mission-controller-router.ts
 * Command routing for the Mission Controller CLI.
 */

import { logger, auditChain } from '@agent/core';
import { getOptionValue, parseCsvOption } from './mission-cli-args.js';
import type { MissionRelationships } from './mission-types.js';

type Awaitable<T> = T | Promise<T>;

export interface MissionControllerRoutingContext {
  argv: string[];
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
    actionName: 'create' | 'start',
    missionId?: string,
    argv?: string[],
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
  ) => Awaitable<void>;
  recordRoutingDecisionInMissionState: (
    missionId: string,
    routingDecision: Record<string, unknown> | null,
    event: 'CREATE' | 'START',
  ) => Awaitable<void>;
  grantMissionAccess: (missionId: string, serviceId: string, ttl?: number) => Awaitable<void>;
  grantMissionSudo: (missionId: string, on?: boolean, ttl?: number) => Awaitable<void>;
  createCheckpoint: (taskId: string, note: string, explicitMissionId?: string) => Awaitable<void>;
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
    },
  ) => Awaitable<void>;
  dispatchMissionWorkItems: (
    id: string,
    options?: {
      mode?: 'auto' | 'agent' | 'subagent';
      limit?: number;
      statuses?: Array<'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'>;
      sources?: Array<'local' | 'github' | 'jira' | 'peer'>;
      finalStatus?: 'review' | 'done';
    },
  ) => Awaitable<void>;
  sealMission: (id: string) => Awaitable<unknown>;
  enqueueMission: (id: string, tier: string, priority: number, deps: string[]) => Awaitable<void>;
  dispatchNextMission: () => Awaitable<void>;
  acceptRubricOverride: (id: string, reason?: string, severity?: string) => void;
  listMemoryQueue: (filterStatus?: 'queued' | 'approved' | 'rejected' | 'promoted') => void;
  approveMemoryCandidate: (candidateId: string, note?: string) => void;
  rejectMemoryCandidate: (candidateId: string, note?: string) => void;
  promoteMemoryCandidate: (
    candidateId: string,
    executionRole?: 'mission_controller' | 'chronos_gateway',
    note?: string,
  ) => void;
  promotePendingMemoryCandidates: (input: {
    executionRole?: 'mission_controller' | 'chronos_gateway';
    dryRun?: boolean;
    note?: string;
  }) => void;
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
  ) => Awaitable<void>;
  purgeMissions: (dryRun?: boolean) => Awaitable<void>;
  listMissions: (filterStatus?: string) => void;
  listOrganizationCatalogs: (organizationId?: string, jsonOutput?: boolean) => Awaitable<void>;
  listOrganizationProfiles: (organizationId?: string) => Awaitable<void>;
  showOrganizationProfile: (organizationId?: string, summaryOnly?: boolean, jsonOutput?: boolean) => Awaitable<void>;
  showOrganizationDiscovery: (jsonOutput?: boolean, summaryOnly?: boolean) => Awaitable<void>;
  showMissionStatus: (id: string) => void;
  showReasoningBackendStatus: () => void;
  syncProjectLedger: (missionId: string) => Awaitable<unknown>;
  showMissionTeam: (id: string, refresh?: boolean, organizationId?: string) => Awaitable<void>;
  staffMissionTeam: (id: string, organizationId?: string) => Awaitable<void>;
  prewarmMissionTeam: (id: string, teamRolesArg?: string, organizationId?: string) => Awaitable<void>;
  classifyMission: (id: string, intentId?: string, taskType?: string) => Awaitable<void>;
  selectMissionWorkflow: (id: string, intentId?: string, taskType?: string) => Awaitable<void>;
  reviewWorkerOutput: (id: string, result?: 'verified' | 'rejected', note?: string) => Awaitable<void>;
  handoffMission: (id: string, nextPersona: string, note?: string) => Awaitable<void>;
  gatePass: (missionId: string, gateId: string, note?: string) => Awaitable<void>;
  gateFail: (missionId: string, gateId: string, note?: string) => Awaitable<void>;
  showHelp: () => void;
}

function parseRoutingDecision(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return { raw };
  }
}

function syncRoutingDecisionSummary(
  context: MissionControllerRoutingContext,
  missionId: string,
  routingDecision: Record<string, unknown> | null,
  event: 'CREATE' | 'START',
): Awaitable<void> {
  return context.recordRoutingDecisionInMissionState(missionId, routingDecision, event);
}

export async function runMissionControllerAction(context: MissionControllerRoutingContext): Promise<void> {
  const {
    action,
    arg1,
    arg2,
    arg3,
    arg4,
    hasDryRun,
    getOptionValue: getValue,
  } = context;

  switch (action) {
    case 'create': {
      const positionalTier = context.arg2 as 'personal' | 'confidential' | 'public' | undefined;
      const createInput = context.validateMissionStartCreateInput('create', arg1, context.argv);
      const routingDecision = parseRoutingDecision(createInput?.routingDecision);
      if (hasDryRun) {
        console.log(
          JSON.stringify(
            {
              action: 'create',
              mission_id: arg1,
              input: createInput,
              routingDecision,
            },
            null,
            2,
          ),
        );
        break;
      }
      await context.createMission(
        arg1!,
        (createInput?.tier || positionalTier || 'confidential') as 'personal' | 'confidential' | 'public',
        createInput?.tenantId,
        createInput?.missionType,
        createInput?.visionRef,
        createInput?.persona,
        createInput?.relationships,
        createInput?.tenantSlug,
        createInput?.organizationId,
      );
      await syncRoutingDecisionSummary(context, arg1!, routingDecision, 'CREATE');
      if (routingDecision) {
        auditChain.record({
          agentId: process.env.KYBERION_PERSONA || 'mission_controller',
          action: 'mission.routing_decision_recorded',
          operation: `create:${arg1}`,
          result: 'completed',
          metadata: {
            mission_id: arg1?.toUpperCase(),
            routing_decision: routingDecision,
          },
        });
      }
      break;
    }
    case 'start': {
      const input = context.validateMissionStartCreateInput('start', arg1, context.argv);
      const routingDecision = parseRoutingDecision(input?.routingDecision);
      if (hasDryRun) {
        console.log(
          JSON.stringify(
            {
              action: 'start',
              mission_id: arg1,
              input,
              routingDecision,
            },
            null,
            2,
          ),
        );
        break;
      }
      await context.startMission(
        arg1!,
        (input?.tier || 'confidential') as 'personal' | 'confidential' | 'public',
        input?.persona,
        input?.tenantId,
        input?.missionType,
        input?.visionRef,
        input?.relationships,
        input?.tenantSlug,
        input?.organizationId,
      );
      await syncRoutingDecisionSummary(context, arg1!, routingDecision, 'START');
      if (routingDecision) {
        auditChain.record({
          agentId: process.env.KYBERION_PERSONA || 'mission_controller',
          action: 'mission.routing_decision_recorded',
          operation: `start:${arg1}`,
          result: 'completed',
          metadata: {
            mission_id: arg1?.toUpperCase(),
            routing_decision: routingDecision,
          },
        });
      }
      break;
    }
    case 'grant':
      await context.grantMissionAccess(arg1!, arg2!, arg3 ? parseInt(arg3) : undefined);
      break;
    case 'sudo':
      await context.grantMissionSudo(arg1!, arg2 !== 'OFF', arg3 ? parseInt(arg3) : undefined);
      break;
    case 'checkpoint':
      if (getValue('--mission-id', context.argv) || getValue('--mission', context.argv)) {
        await context.createCheckpoint(arg1 || 'manual', arg2 || 'progress update', getValue('--mission-id', context.argv) || getValue('--mission', context.argv));
      } else if (arg3) {
        await context.createCheckpoint(arg2 || 'manual', arg3 || 'progress update', arg1);
      } else {
        await context.createCheckpoint(arg1 || 'manual', arg2 || 'progress update');
      }
      break;
    case 'delegate':
      await context.delegateMission(arg1!, arg2!, arg3!);
      break;
    case 'import':
      await context.importMission(arg1!, arg2!);
      break;
    case 'verify':
      await context.verifyMission(arg1!, (arg2 as 'verified' | 'rejected') || 'verified', arg3 || '');
      break;
    case 'distill':
      await context.distillMission(arg1!);
      break;
    case 'dispatch-tickets':
      await context.dispatchMissionTickets(arg1!);
      break;
    case 'dispatch-workitems':
      await context.dispatchMissionWorkItems(arg1!);
      break;
    case 'seal':
      await context.sealMission(arg1!);
      break;
    case 'enqueue':
      await context.enqueueMission(arg1!, arg2!, parseInt(arg3 || '5'), arg4 ? arg4.split(',') : []);
      break;
    case 'dispatch':
      await context.dispatchNextMission();
      break;
    case 'accept-with-override':
      context.acceptRubricOverride(
        arg1!,
        getValue('--reason', context.argv),
        getValue('--severity', context.argv),
      );
      break;
    case 'memory-queue':
      context.listMemoryQueue(arg1 as any);
      break;
    case 'memory-approve':
      context.approveMemoryCandidate(arg1!, getValue('--note', context.argv));
      break;
    case 'memory-reject':
      context.rejectMemoryCandidate(arg1!, getValue('--note', context.argv));
      break;
    case 'memory-promote':
      context.promoteMemoryCandidate(
        arg1!,
        (getValue('--execution-role', context.argv) as 'mission_controller' | 'chronos_gateway') || 'mission_controller',
        getValue('--note', context.argv),
      );
      break;
    case 'memory-promote-pending':
      context.promotePendingMemoryCandidates({
        executionRole:
          (getValue('--execution-role', context.argv) as 'mission_controller' | 'chronos_gateway') ||
          'mission_controller',
        note: getValue('--note', context.argv),
        dryRun: context.argv.includes('--dry-run'),
      });
      break;
    case 'finish':
      await context.finishMission(arg1!, context.argv.includes('--seal'));
      break;
    case 'resume':
      await context.resumeMission(arg1);
      break;
    case 'record-task':
      await context.recordTask(arg1!, arg2!, JSON.parse(context.arg3 || '{}'));
      break;
    case 'record-evidence':
      await context.recordEvidence(
        arg1!,
        arg2 || 'manual',
        arg3 || 'evidence recorded',
        parseCsvOption('--evidence', context.argv),
        getValue('--team-role', context.argv),
        getValue('--actor-id', context.argv),
        getValue('--actor-type', context.argv) as any,
      );
      break;
    case 'purge':
      await context.purgeMissions(!context.argv.includes('--execute'));
      break;
    case 'list':
      context.listMissions(arg1);
      break;
    case 'organization-catalogs':
      await context.listOrganizationCatalogs(
        getValue('--organization-id', context.argv) || getValue('--org', context.argv),
        context.argv.includes('--json'),
      );
      break;
    case 'organization-profiles':
      await context.listOrganizationProfiles(getValue('--organization-id', context.argv) || getValue('--org', context.argv));
      break;
    case 'organization-profile':
      await context.showOrganizationProfile(
        getValue('--organization-id', context.argv) || getValue('--org', context.argv),
        context.argv.includes('--summary') || context.argv.includes('--compact'),
        context.argv.includes('--json'),
      );
      break;
    case 'organization-discovery':
      await context.showOrganizationDiscovery(
        context.argv.includes('--json'),
        context.argv.includes('--summary') || context.argv.includes('--compact'),
      );
      break;
    case 'status':
      context.showMissionStatus(arg1!);
      context.showReasoningBackendStatus();
      break;
    case 'sync-project-ledger':
      await context.syncProjectLedger(arg1!);
      break;
    case 'team':
      await context.showMissionTeam(arg1!, context.hasRefresh, getValue('--organization-id', context.argv) || getValue('--org', context.argv));
      break;
    case 'staff':
      await context.staffMissionTeam(arg1!, getValue('--organization-id', context.argv) || getValue('--org', context.argv));
      break;
    case 'prewarm':
      await context.prewarmMissionTeam(arg1!, arg2, getValue('--organization-id', context.argv) || getValue('--org', context.argv));
      break;
    case 'classify':
      await context.classifyMission(arg1!, arg2, arg3);
      break;
    case 'workflow-select':
      await context.selectMissionWorkflow(arg1!, arg2, arg3);
      break;
    case 'review-worker-output':
      await context.reviewWorkerOutput(arg1!, (arg2 as 'verified' | 'rejected') || 'verified', arg3);
      break;
    case 'handoff':
      await context.handoffMission(arg1!, arg2!, arg3);
      break;
    case 'gate-pass':
      await context.gatePass(arg1!, arg2!, getValue('--note', context.argv));
      break;
    case 'gate-fail':
      await context.gateFail(arg1!, arg2!, getValue('--note', context.argv));
      break;
    case 'sync':
      logger.info('Syncing mission registry...');
      break;
    case 'help':
    case '--help':
    case '-h':
      context.showHelp();
      break;
    default:
      context.showHelp();
  }
}
