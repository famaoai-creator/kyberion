export type HandoffPacketKind = 'work_item' | 'mission';

export interface HandoffPacket {
  kind: HandoffPacketKind;
  correlation_id: string;
  outgoing_summary: string;
  open_decisions: string[];
  partial_artifacts: string[];
  remaining_acceptance_criteria: string[];
  rationale: string;
  source_ref?: string;
  target_ref?: string;
  created_at: string;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function buildHandoffPacket(input: {
  kind: HandoffPacketKind;
  correlationId: string;
  outgoingSummary: string;
  rationale?: string;
  openDecisions?: unknown;
  partialArtifacts?: unknown;
  remainingAcceptanceCriteria?: unknown;
  sourceRef?: string;
  targetRef?: string;
}): HandoffPacket {
  return {
    kind: input.kind,
    correlation_id: input.correlationId,
    outgoing_summary: input.outgoingSummary.trim(),
    open_decisions: asStringList(input.openDecisions),
    partial_artifacts: asStringList(input.partialArtifacts),
    remaining_acceptance_criteria: asStringList(input.remainingAcceptanceCriteria),
    rationale:
      firstString(input.rationale) ??
      'Not specified; use the outgoing summary as fallback context.',
    ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
    ...(input.targetRef ? { target_ref: input.targetRef } : {}),
    created_at: new Date().toISOString(),
  };
}

function extractListMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): unknown {
  if (!metadata) return undefined;
  for (const key of keys) {
    if (key in metadata) return metadata[key];
  }
  return undefined;
}

function extractTextMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const candidate = metadata[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function buildWorkItemHandoffPacket(input: {
  itemId: string;
  itemTitle: string;
  purpose: string;
  fromPeerId: string;
  toPeerId: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}): HandoffPacket {
  const summary = firstString(
    extractTextMetadata(input.metadata, ['outgoing_summary', 'outgoingSummary']),
    `Work item ${input.itemId} handed off from ${input.fromPeerId} to ${input.toPeerId} for ${input.purpose}.`
  );

  return buildHandoffPacket({
    kind: 'work_item',
    correlationId: input.correlationId,
    outgoingSummary: summary ?? '',
    rationale:
      extractTextMetadata(input.metadata, ['rationale', 'handoff_rationale']) ??
      `Continue the work item with purpose "${input.purpose}".`,
    openDecisions: extractListMetadata(input.metadata, [
      'open_decisions',
      'openDecisions',
      'open_questions',
    ]),
    partialArtifacts: extractListMetadata(input.metadata, [
      'partial_artifacts',
      'partialArtifacts',
      'artifacts',
      'artifact_refs',
    ]),
    remainingAcceptanceCriteria: extractListMetadata(input.metadata, [
      'remaining_acceptance_criteria',
      'remainingAcceptanceCriteria',
      'acceptance_criteria',
      'acceptanceCriteria',
    ]),
    sourceRef: `peer:${input.fromPeerId}`,
    targetRef: `peer:${input.toPeerId}`,
  });
}

export function buildMissionHandoffPacket(input: {
  missionId: string;
  previousPersona: string;
  nextPersona: string;
  note?: string;
  correlationId?: string;
  context?: {
    last_action?: string;
    next_step?: string;
    blockers?: string[];
    associated_projects?: string[];
    mission_completion_summary?: {
      requested_result: string;
      satisfied: boolean;
      delivered: string[];
      gaps: string[];
      next_step: string;
      confidence: number;
    };
    mission_completion_next_action?: {
      title: string;
      request: string;
      delivered: string[];
      gaps: string[];
      next_step: string;
      satisfied: boolean;
      confidence: number;
      evidence_refs: string[];
    };
    intent_delta_summary?: {
      checked_at: string;
      passed: boolean;
      verdict: string;
      drift_score: number;
      message: string;
    };
    context_pack_summary?: string;
  };
}): HandoffPacket {
  const completionSummary = input.context?.mission_completion_summary;
  const nextAction = input.context?.mission_completion_next_action;
  const outgoingSummary =
    input.note?.trim() ||
    input.context?.context_pack_summary ||
    input.context?.last_action ||
    `Mission ${input.missionId} handed off from ${input.previousPersona} to ${input.nextPersona}.`;

  return buildHandoffPacket({
    kind: 'mission',
    correlationId:
      input.correlationId ??
      `${input.missionId}:${input.previousPersona}->${input.nextPersona}:${Date.now().toString(36)}`,
    outgoingSummary,
    rationale:
      input.note?.trim() ||
      input.context?.intent_delta_summary?.message ||
      `Continue mission ${input.missionId} under ${input.nextPersona}.`,
    openDecisions: [
      ...(input.context?.blockers || []),
      ...(completionSummary?.gaps || []),
      ...(nextAction?.gaps || []),
    ],
    partialArtifacts: [
      ...(completionSummary?.delivered || []),
      ...(nextAction?.delivered || []),
      ...(input.context?.associated_projects || []),
    ],
    remainingAcceptanceCriteria: [
      ...(completionSummary?.gaps || []),
      ...(nextAction?.gaps || []),
      ...(completionSummary?.next_step ? [completionSummary.next_step] : []),
      ...(input.context?.next_step ? [input.context.next_step] : []),
      ...(nextAction?.next_step ? [nextAction.next_step] : []),
    ],
    sourceRef: `persona:${input.previousPersona}`,
    targetRef: `persona:${input.nextPersona}`,
  });
}
