import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { safeExec, safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { buildExecutionEnv, withExecutionContext } from './authority.js';
import { enqueueMissionOrchestrationEvent, startMissionOrchestrationWorker } from './mission-orchestration-events.js';
import { appendGovernedArtifactJsonl, writeGovernedArtifactJson } from './artifact-store.js';
import type { AgentRoutingDecision } from './intent-contract.js';

import type {
  ChronosMissionProposalState,
  MissionProposal,
  SlackMissionIssuanceResult,
  SlackMissionProposalState,
} from './channel-surface-types.js';

type SurfaceProposalRole = 'slack_bridge' | 'chronos_gateway';

function writeJsonAs(role: SurfaceProposalRole, logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson(role, logicalPath, record);
}

function appendJsonlAs(role: SurfaceProposalRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function withSurfaceRole<T>(role: SurfaceProposalRole, fn: () => T): T {
  return withExecutionContext(role, fn);
}

function emitSlackMissionEvent(event: Record<string, unknown>): string {
  return appendJsonlAs('slack_bridge', 'active/shared/observability/channels/slack/missions.jsonl', {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel: 'slack',
    ...event,
  });
}

function emitChronosMissionEvent(event: Record<string, unknown>): string {
  return appendJsonlAs('chronos_gateway', 'active/shared/observability/chronos/missions.jsonl', {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel: 'chronos',
    ...event,
  });
}

function missionProposalStateLogicalPath(surface: 'slack' | 'chronos', channel: string, threadTs: string): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `active/shared/coordination/channels/${surface}/mission-proposals/${channel}-${safeThread}.json`;
}

function sanitizeMissionSlug(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'REQUEST';
}

function buildSurfaceMissionId(prefix: string, threadTs: string, proposal: MissionProposal, sourceText?: string): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || 'request';
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, '').slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}

function formatRoutingDecisionSummary(routingDecision?: AgentRoutingDecision): string | undefined {
  if (!routingDecision) return undefined;
  const parts: string[] = [routingDecision.mode];
  if (routingDecision.owner) parts.push(`owner=${routingDecision.owner}`);
  if (routingDecision.fanout && routingDecision.fanout !== 'none') parts.push(`fanout=${routingDecision.fanout}`);
  return parts.join(', ');
}

export function getSlackMissionProposalState(channel: string, threadTs: string): SlackMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('slack', channel, threadTs);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as SlackMissionProposalState;
}

export function saveSlackMissionProposalState(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): string {
  return writeJsonAs('slack_bridge', missionProposalStateLogicalPath('slack', params.channel, params.threadTs), {
    surface: 'slack',
    channel: params.channel,
    threadTs: params.threadTs,
    proposal: params.proposal,
    sourceText: params.sourceText,
    routingDecision: params.routingDecision,
    createdAt: new Date().toISOString(),
  } satisfies SlackMissionProposalState);
}

export function clearSlackMissionProposalState(channel: string, threadTs: string): void {
  const resolved = pathResolver.resolve(missionProposalStateLogicalPath('slack', channel, threadTs));
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('slack_bridge', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function getChronosMissionProposalState(sessionId: string): ChronosMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('chronos', 'chronos', sessionId);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as ChronosMissionProposalState;
}

export function saveChronosMissionProposalState(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): string {
  return writeJsonAs('chronos_gateway', missionProposalStateLogicalPath('chronos', 'chronos', params.sessionId), {
    surface: 'chronos',
    channel: 'chronos',
    threadTs: params.sessionId,
    proposal: params.proposal,
    sourceText: params.sourceText,
    routingDecision: params.routingDecision,
    createdAt: new Date().toISOString(),
  } satisfies ChronosMissionProposalState);
}

export function clearChronosMissionProposalState(sessionId: string): void {
  const resolved = pathResolver.resolve(missionProposalStateLogicalPath('chronos', 'chronos', sessionId));
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('chronos_gateway', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function isSlackMissionConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /^はい[。！!]?$/,
    /^お願いします?[。！!]?$/,
    /^ではよろしく[。！!]?$/,
    /^よろしくお願いします?[。！!]?$/,
    /^進めて$/,
    /^go ahead$/,
    /^yes$/,
    /^approved?$/,
    /^please proceed$/,
  ].some((pattern) => pattern.test(normalized));
}

export async function issueSlackMissionFromProposal(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): Promise<SlackMissionIssuanceResult> {
  const missionId = buildSurfaceMissionId('SLACK', params.threadTs, params.proposal, params.sourceText);
  const tier = params.proposal.tier || 'public';
  const missionType = params.proposal.mission_type || 'development';
  const persona = params.proposal.assigned_persona || 'Ecosystem Architect';
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const routingDecisionArg = params.routingDecision
    ? ['--routing-decision', JSON.stringify(params.routingDecision)]
    : [];

  const startOutput = safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'start', missionId, tier, persona, 'default', missionType, ...routingDecisionArg],
    { env, cwd: pathResolver.rootDir() },
  );
  let orchestrationStatus: SlackMissionIssuanceResult['orchestrationStatus'] = 'queued';
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    const orchestrationEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'slack_bridge',
      correlationId: randomUUID(),
      payload: {
        channel: params.channel,
        threadTs: params.threadTs,
        proposal: params.proposal,
        sourceText: params.sourceText,
        tier,
        persona,
        missionType,
      },
    });
    orchestrationJobPath = startMissionOrchestrationWorker(orchestrationEvent);
  } catch (error) {
    orchestrationStatus = 'failed';
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  emitSlackMissionEvent({
    correlation_id: randomUUID(),
    decision: 'mission_issued',
    why: 'A confirmed Slack mission proposal was deterministically issued through mission_controller.',
    policy_used: 'slack_mission_issue_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    thread_ts: params.threadTs,
    slack_channel: params.channel,
    mission_type: missionType,
    tier,
    routing_decision_summary: formatRoutingDecisionSummary(params.routingDecision),
    orchestration_status: orchestrationStatus,
    orchestration_job_path: orchestrationJobPath,
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
    routingDecision: params.routingDecision,
  };
}

export async function issueChronosMissionFromProposal(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): Promise<SlackMissionIssuanceResult> {
  const missionId = buildSurfaceMissionId('CHRONOS', params.sessionId, params.proposal, params.sourceText);
  const tier = params.proposal.tier || 'public';
  const missionType = params.proposal.mission_type || 'development';
  const persona = params.proposal.assigned_persona || 'Ecosystem Architect';
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const routingDecisionArg = params.routingDecision
    ? ['--routing-decision', JSON.stringify(params.routingDecision)]
    : [];

  const startOutput = safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'start', missionId, tier, persona, 'default', missionType, ...routingDecisionArg],
    { env, cwd: pathResolver.rootDir() },
  );

  let orchestrationStatus: SlackMissionIssuanceResult['orchestrationStatus'] = 'queued';
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    const orchestrationEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'chronos_gateway',
      correlationId: randomUUID(),
      payload: {
        sessionId: params.sessionId,
        proposal: params.proposal,
        sourceText: params.sourceText,
        tier,
        persona,
        missionType,
        channel: 'chronos',
        threadTs: params.sessionId,
      },
    });
    orchestrationJobPath = startMissionOrchestrationWorker(orchestrationEvent);
  } catch (error) {
    orchestrationStatus = 'failed';
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  emitChronosMissionEvent({
    correlation_id: randomUUID(),
    decision: 'mission_issued',
    why: 'A confirmed Chronos mission proposal was deterministically issued through mission_controller.',
    policy_used: 'chronos_mission_issue_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    mission_type: missionType,
    tier,
    session_id: params.sessionId,
    routing_decision_summary: formatRoutingDecisionSummary(params.routingDecision),
    orchestration_status: orchestrationStatus,
    orchestration_job_path: orchestrationJobPath,
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
    routingDecision: params.routingDecision,
  };
}
