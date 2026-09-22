import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';

export interface HearingScenarioRequirement {
  id: string;
  /** HT-06 (i18n gate): a `front_desk:*` vocabulary key, never raw display
   * text — callers resolve it with `t()`/`catalogT()` at render time, per
   * request locale. Persisted `HearingRequirement`s keep this key too, so a
   * locale change re-renders instead of freezing the answering locale. */
  label_key: string;
  aliases?: string[];
}

export interface HearingScenario {
  id: string;
  requirements: HearingScenarioRequirement[];
}

/** WI-08: pure `{id, requirements}` shape derived from the
 * `hearing-scenarios.json` catalog entry (`libs/core/hearing-scenario-catalog.ts`)
 * — the catalog is the single source of truth for the requirement set,
 * `createHearingRecord`/`applyHearingTurn` only need this thin projection.
 * Throws (via `findHearingScenario`/`loadHearingScenarios`'s governed-catalog
 * validation) if the catalog is missing its `web_app_build` entry, the same
 * way any other required catalog failing to load would surface. */
function hearingScenarioFromCatalog(id: string): HearingScenario {
  const entry = findHearingScenario(id);
  if (!entry) {
    throw new Error(
      `[HEARING_SCENARIO_CATALOG_MISSING] no '${id}' entry in hearing-scenarios.json`
    );
  }
  return {
    id: entry.id,
    requirements: entry.requirements.map(({ id: requirementId, label_key, aliases }) => ({
      id: requirementId,
      label_key,
      ...(aliases ? { aliases } : {}),
    })),
  };
}

export const WEB_APP_HEARING_SCENARIO: HearingScenario =
  hearingScenarioFromCatalog('web_app_build');

export type HearingRequirementId = string;

export interface HearingRequirement {
  id: HearingRequirementId;
  label_key: string;
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

/** HT-02: coarse status of the model-generated canvas for the *current*
 * (latest) `canvas_versions` entry — never persisted per past version, only
 * the current one, so a rollback to an older `vN` via `?version=vN` does not
 * need to rewrite history. `canvas_version_sources` is the optional per-
 * version record of which path produced each `vN` (additive; older records
 * without it stay valid — callers must treat a missing entry as unknown,
 * not as `template`). */
export type HearingCanvasGenerationState = 'pending' | 'generated' | 'template';

export interface HearingRecord {
  session_id: string;
  scenario: string;
  requirements: HearingRequirement[];
  canvas_versions: string[];
  updated_at: string;
  decided_by?: HearingDecidedBy;
  decided_at?: string;
  canvas_generation?: HearingCanvasGenerationState;
  canvas_version_sources?: Record<string, 'template' | 'generated'>;
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
    if (!requirement.id.trim() || !requirement.label_key.trim() || ids.has(requirement.id)) {
      throw new Error('[HEARING_SCENARIO_INVALID] requirement ids and labels must be unique');
    }
    ids.add(requirement.id);
  }
  return {
    session_id: sessionId,
    scenario: scenario.id,
    requirements: scenario.requirements.map(({ id, label_key }) => ({
      id,
      label_key,
      confidence: 0,
    })),
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
      typeof requirement.label_key !== 'string' ||
      !requirement.label_key.trim() ||
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
