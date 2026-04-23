import { randomUUID } from 'node:crypto';

import { appendGovernedArtifactJsonl, ensureGovernedArtifactDir, writeGovernedArtifactJson } from './artifact-store.js';

import type {
  ChronosSurfaceRequest,
  SlackSurfaceArtifact,
  SurfaceEvent,
  SurfaceRole,
} from './channel-surface-types.js';

function ensureDirAs(role: SurfaceRole, logicalPath: string): string {
  return ensureGovernedArtifactDir(role, logicalPath);
}

function appendJsonlAs(role: SurfaceRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function writeJsonAs(role: SurfaceRole, logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson(role, logicalPath, record);
}

export function emitChannelSurfaceEvent(
  role: SurfaceRole,
  channel: string,
  stream: string,
  event: Omit<SurfaceEvent, 'ts' | 'event_id' | 'channel'>,
): string {
  return appendJsonlAs(role, `active/shared/observability/channels/${channel}/${stream}.jsonl`, {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel,
    ...event,
  });
}

export function emitChronosSurfaceEvent(
  stream: string,
  event: Omit<SurfaceEvent, 'ts' | 'event_id' | 'channel'>,
): string {
  return appendJsonlAs('chronos_gateway', `active/shared/observability/chronos/${stream}.jsonl`, {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel: 'chronos',
    ...event,
  });
}

export function recordSlackSurfaceArtifact(artifact: SlackSurfaceArtifact): string {
  ensureDirAs('slack_bridge', 'active/shared/coordination/channels/slack/inbox');
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'events', {
    correlation_id: artifact.correlationId,
    decision: 'handoff_prepared',
    why: 'Slack Surface Agent normalized conversational input and created a channel-local handoff artifact.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: 'slack-surface-agent',
    resource_id: artifact.stimulus.id,
    thread_context: artifact.stimulus.origin.context,
  });
  return writeJsonAs('slack_bridge', artifact.inboxPath, artifact);
}

export function recordChronosSurfaceRequest(input: ChronosSurfaceRequest): string {
  const correlationId = randomUUID();
  const sessionId = input.sessionId || 'default';
  ensureDirAs('chronos_gateway', `active/shared/coordination/chronos/sessions/${sessionId}`);

  const artifact = {
    ts: new Date().toISOString(),
    correlation_id: correlationId,
    session_id: sessionId,
    requester_id: input.requesterId || 'unknown',
    query: input.query,
    agent_id: 'chronos-surface-agent',
  };

  emitChronosSurfaceEvent('requests', {
    correlation_id: correlationId,
    decision: 'request_received',
    why: 'Chronos Surface Agent accepted an authenticated control request and prepared runtime routing state.',
    policy_used: 'chronos_surface_agent_v1',
    agent_id: 'chronos-surface-agent',
    resource_id: sessionId,
  });

  return writeJsonAs(
    'chronos_gateway',
    `active/shared/coordination/chronos/sessions/${sessionId}/${correlationId}.json`,
    artifact,
  );
}

export function recordChronosDelegationSummary(
  correlationId: string,
  delegationCount: number,
  delegatedAgents: string[],
): string {
  return emitChronosSurfaceEvent('delegations', {
    correlation_id: correlationId,
    decision: 'delegation_processed',
    why: 'Chronos Surface Agent recorded A2A delegation activity for explainable control-plane tracing.',
    policy_used: 'chronos_surface_agent_v1',
    agent_id: 'chronos-surface-agent',
    resource_id: delegatedAgents.join(','),
    delegation_count: delegationCount,
  });
}

export function recordSlackDelivery(
  correlationId: string,
  channel: string,
  threadTs: string,
  deliveryTs?: string,
  source: 'surface' | 'nerve' | 'system' = 'surface',
): string {
  return emitChannelSurfaceEvent('slack_bridge', 'slack', 'deliveries', {
    correlation_id: correlationId,
    decision: 'delivery_sent',
    why: 'Slack Surface Agent response was delivered back to the originating Slack thread.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: 'slack-surface-agent',
    resource_id: deliveryTs || threadTs,
    slack_channel: channel,
    thread_ts: threadTs,
    response_source: source,
  });
}
