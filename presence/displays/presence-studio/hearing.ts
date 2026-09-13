import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';

export const HEARING_REQUIREMENTS = [
  { id: 'audience', label: '対象となる人' },
  { id: 'problem', label: '解決したいこと' },
  { id: 'core_flow', label: '主な流れ' },
  { id: 'content', label: '載せる内容' },
  { id: 'visual_direction', label: '見た目の方向' },
  { id: 'constraints', label: '制約・条件' },
  { id: 'success', label: 'できたと判断する条件' },
] as const;

export type HearingRequirementId = (typeof HEARING_REQUIREMENTS)[number]['id'];

export interface HearingRequirement {
  id: HearingRequirementId;
  label: string;
  answer?: string;
  confidence: number;
  source_turn?: string;
}

export interface HearingRecord {
  session_id: string;
  scenario: 'web_app_build';
  requirements: HearingRequirement[];
  canvas_versions: string[];
  updated_at: string;
}

export interface HearingTurn {
  text: string;
  request_id: string;
  intent_resolution?: IntentResolutionContract;
}

export function createHearingRecord(sessionId: string, now: string): HearingRecord {
  return {
    session_id: sessionId,
    scenario: 'web_app_build',
    requirements: HEARING_REQUIREMENTS.map(({ id, label }) => ({
      id,
      label,
      confidence: 0,
    })),
    canvas_versions: [],
    updated_at: now,
  };
}

function requirementIdForInput(input: string): HearingRequirementId | undefined {
  const normalized = input.toLowerCase().replace(/[-\s]+/g, '_');
  const aliases: Partial<Record<string, HearingRequirementId>> = {
    target: 'audience',
    audience: 'audience',
    users: 'audience',
    user: 'audience',
    goal: 'problem',
    problem: 'problem',
    use_case: 'problem',
    flow: 'core_flow',
    core_flow: 'core_flow',
    content: 'content',
    visual: 'visual_direction',
    visual_direction: 'visual_direction',
    constraints: 'constraints',
    constraint: 'constraints',
    success: 'success',
    acceptance: 'success',
  };
  return aliases[normalized];
}

/** Apply one bounded conversation turn without inventing answers. */
export function applyHearingTurn(
  record: HearingRecord,
  turn: HearingTurn,
  now: string
): HearingRecord {
  const text = turn.text.trim();
  if (!text) return { ...record, updated_at: now };

  const requestedId = turn.intent_resolution?.missing_inputs
    .map(requirementIdForInput)
    .find((id): id is HearingRequirementId => Boolean(id));
  const target =
    record.requirements.find((item) => item.id === requestedId) ||
    record.requirements.find((item) => !item.answer);
  if (!target) return { ...record, updated_at: now };

  return {
    ...record,
    requirements: record.requirements.map((item) =>
      item.id === target.id
        ? { ...item, answer: text, confidence: 0.5, source_turn: turn.request_id }
        : item
    ),
    updated_at: now,
  };
}

export function hearingCoverage(record: HearingRecord): { complete: number; total: number } {
  const total = record.requirements.length;
  return { complete: record.requirements.filter((item) => Boolean(item.answer)).length, total };
}
