import { isRecord } from '@agent/core/foundation';
import type { AgentRoutingDecision } from '@agent/core/intent-contract';

export type MissionProposal = {
  intent: 'create_mission';
  mission_type?: string;
  summary?: string;
  assigned_persona?: string;
  tier?: 'personal' | 'confidential' | 'public';
  vision_ref?: string;
  why?: string;
};

export type ChronosMissionProposalState = {
  surface: 'chronos';
  channel: 'chronos';
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  createdAt: string;
};

export type ChronosAuditEvent = {
  metadata?: {
    routing_decision?: { mode?: string; owner?: string; fanout?: string };
  };
  ts?: string;
  decision?: string;
  action?: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  agentId?: string;
  result?: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseChronosAuditEvent(value: unknown): ChronosAuditEvent | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const rawRoutingDecision = metadata?.routing_decision;
  const routingDecision = isRecord(rawRoutingDecision)
    ? {
        ...(optionalString(rawRoutingDecision.mode)
          ? { mode: optionalString(rawRoutingDecision.mode) }
          : {}),
        ...(optionalString(rawRoutingDecision.owner)
          ? { owner: optionalString(rawRoutingDecision.owner) }
          : {}),
        ...(optionalString(rawRoutingDecision.fanout)
          ? { fanout: optionalString(rawRoutingDecision.fanout) }
          : {}),
      }
    : undefined;
  const event: ChronosAuditEvent = {
    ...(optionalString(value.ts) ? { ts: optionalString(value.ts) } : {}),
    ...(optionalString(value.decision) ? { decision: optionalString(value.decision) } : {}),
    ...(optionalString(value.action) ? { action: optionalString(value.action) } : {}),
    ...(optionalString(value.event_type) ? { event_type: optionalString(value.event_type) } : {}),
    ...(optionalString(value.mission_id) ? { mission_id: optionalString(value.mission_id) } : {}),
    ...(optionalString(value.resource_id)
      ? { resource_id: optionalString(value.resource_id) }
      : {}),
    ...(optionalString(value.agentId) ? { agentId: optionalString(value.agentId) } : {}),
    ...(optionalString(value.result) ? { result: optionalString(value.result) } : {}),
    ...(routingDecision ? { metadata: { routing_decision: routingDecision } } : {}),
  };
  return event.decision || event.action || event.event_type ? event : null;
}

function parseMissionProposal(value: unknown): MissionProposal | null {
  if (!isRecord(value) || value.intent !== 'create_mission') return null;
  const proposal: MissionProposal = { intent: 'create_mission' };
  for (const key of ['mission_type', 'summary', 'assigned_persona', 'vision_ref', 'why'] as const) {
    const parsed = optionalString(value[key]);
    if (parsed) proposal[key] = parsed;
  }
  if (
    value.tier !== undefined &&
    value.tier !== 'personal' &&
    value.tier !== 'confidential' &&
    value.tier !== 'public'
  ) {
    return null;
  }
  if (value.tier) proposal.tier = value.tier;
  return proposal;
}

function parseChronosRoutingDecision(value: unknown): AgentRoutingDecision | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  const scope = value.scope;
  const autonomy = value.autonomy;
  const fanout = value.fanout;
  const delegates = value.delegates;
  const artifactCount = value.artifact_count;
  if (
    value.kind !== 'agent-routing-decision' ||
    (mode !== 'prompt' && mode !== 'subagent' && mode !== 'coordination') ||
    (scope !== 'single_artifact' &&
      scope !== 'multi_artifact' &&
      scope !== 'stateful_flow' &&
      scope !== 'boundary_crossing') ||
    (autonomy !== 'low' && autonomy !== 'medium' && autonomy !== 'high') ||
    (fanout !== 'none' &&
      fanout !== 'parallel' &&
      fanout !== 'review' &&
      fanout !== 'cross_critique') ||
    typeof value.boundary_crossing !== 'boolean' ||
    typeof value.source_text !== 'string' ||
    typeof value.intent_id !== 'string' ||
    typeof value.owner !== 'string' ||
    typeof value.stop_condition !== 'string' ||
    typeof value.rationale !== 'string' ||
    typeof artifactCount !== 'number' ||
    !Number.isInteger(artifactCount) ||
    artifactCount < 0 ||
    (delegates !== undefined &&
      (!Array.isArray(delegates) || delegates.some((entry) => typeof entry !== 'string')))
  ) {
    return null;
  }
  return {
    kind: 'agent-routing-decision',
    source_text: value.source_text,
    intent_id: value.intent_id,
    mode,
    scope,
    autonomy,
    boundary_crossing: value.boundary_crossing,
    fanout,
    owner: value.owner,
    ...(delegates ? { delegates } : {}),
    artifact_count: artifactCount,
    stop_condition: value.stop_condition,
    rationale: value.rationale,
  };
}

export function parseChronosMissionProposalState(
  value: unknown
): ChronosMissionProposalState | null {
  if (!isRecord(value)) return null;
  const proposal = parseMissionProposal(value.proposal);
  const threadTs = optionalString(value.threadTs);
  const createdAt = optionalString(value.createdAt);
  const routingDecision =
    value.routingDecision === undefined
      ? undefined
      : parseChronosRoutingDecision(value.routingDecision);
  if (
    value.surface !== 'chronos' ||
    value.channel !== 'chronos' ||
    !proposal ||
    !threadTs ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt)) ||
    (value.routingDecision !== undefined && !routingDecision)
  ) {
    return null;
  }
  const sourceText = value.sourceText === undefined ? undefined : optionalString(value.sourceText);
  if (value.sourceText !== undefined && sourceText === undefined) return null;
  return {
    surface: 'chronos',
    channel: 'chronos',
    threadTs,
    proposal,
    ...(sourceText ? { sourceText } : {}),
    ...(routingDecision ? { routingDecision } : {}),
    createdAt,
  };
}
