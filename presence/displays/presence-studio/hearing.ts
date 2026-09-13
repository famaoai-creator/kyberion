import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';

export interface HearingScenarioRequirement {
  id: string;
  label: string;
  aliases?: string[];
}

export interface HearingScenario {
  id: string;
  requirements: HearingScenarioRequirement[];
}

export const WEB_APP_HEARING_SCENARIO: HearingScenario = {
  id: 'web_app_build',
  requirements: [
    { id: 'audience', label: '対象となる人', aliases: ['target', 'users', 'user'] },
    { id: 'problem', label: '解決したいこと', aliases: ['goal', 'use_case'] },
    { id: 'core_flow', label: '主な流れ', aliases: ['flow'] },
    { id: 'content', label: '載せる内容' },
    { id: 'visual_direction', label: '見た目の方向', aliases: ['visual'] },
    { id: 'constraints', label: '制約・条件', aliases: ['constraint'] },
    { id: 'success', label: 'できたと判断する条件', aliases: ['acceptance'] },
  ],
};

export type HearingRequirementId = string;

export interface HearingRequirement {
  id: HearingRequirementId;
  label: string;
  answer?: string;
  confidence: number;
  source_turn?: string;
}

/** FD-10 (plan §2.5 principle 4): decisions are human-only, recorded through
 * `libs/core/actor.ts`'s `humanActor` shape plus the deciding member's
 * front-desk role — never the synthetic loopback/token principal id. */
export interface HearingDecidedBy {
  kind: 'human';
  id: string;
  display_name?: string;
  role: 'owner' | 'approver' | 'viewer';
}

export interface HearingRecord {
  session_id: string;
  scenario: string;
  requirements: HearingRequirement[];
  canvas_versions: string[];
  updated_at: string;
  decided_by?: HearingDecidedBy;
  decided_at?: string;
}

export interface HearingTurn {
  text: string;
  request_id: string;
  intent_resolution?: IntentResolutionContract;
}

export function createHearingRecord(
  sessionId: string,
  now: string,
  scenario: HearingScenario = WEB_APP_HEARING_SCENARIO
): HearingRecord {
  validateHearingScenario(scenario);
  const ids = new Set<string>();
  for (const requirement of scenario.requirements) {
    if (!requirement.id.trim() || !requirement.label.trim() || ids.has(requirement.id)) {
      throw new Error('[HEARING_SCENARIO_INVALID] requirement ids and labels must be unique');
    }
    ids.add(requirement.id);
  }
  return {
    session_id: sessionId,
    scenario: scenario.id,
    requirements: scenario.requirements.map(({ id, label }) => ({ id, label, confidence: 0 })),
    canvas_versions: [],
    updated_at: now,
  };
}

export function validateHearingScenario(scenario: HearingScenario): void {
  if (
    !scenario ||
    typeof scenario.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(scenario.id.trim()) ||
    !Array.isArray(scenario.requirements) ||
    scenario.requirements.length === 0
  ) {
    throw new Error('[HEARING_SCENARIO_INVALID] scenario requires a safe id and requirements');
  }
  const ids = new Set<string>();
  for (const requirement of scenario.requirements) {
    if (
      !requirement ||
      typeof requirement.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(requirement.id.trim()) ||
      typeof requirement.label !== 'string' ||
      !requirement.label.trim() ||
      ids.has(requirement.id)
    ) {
      throw new Error(
        '[HEARING_SCENARIO_INVALID] requirement ids and labels must be unique and safe'
      );
    }
    ids.add(requirement.id);
  }
}

function requirementIdForInput(
  input: string,
  scenario: HearingScenario
): HearingRequirementId | undefined {
  const normalized = input.toLowerCase().replace(/[-\s]+/g, '_');
  return scenario.requirements.find(
    (requirement) =>
      requirement.id === normalized ||
      (requirement.aliases || []).some((alias) => alias.toLowerCase() === normalized)
  )?.id;
}

/** Apply one bounded conversation turn without inventing answers. */
export function applyHearingTurn(
  record: HearingRecord,
  turn: HearingTurn,
  now: string,
  scenario: HearingScenario = WEB_APP_HEARING_SCENARIO
): HearingRecord {
  const text = turn.text.trim();
  if (!text) return { ...record, updated_at: now };

  const requestedId = turn.intent_resolution?.missing_inputs
    .map((input) => requirementIdForInput(input, scenario))
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
