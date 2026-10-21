/**
 * hearing-scenario-catalog.ts — WI-08: governed catalog of presence-studio
 * `/ask?mode=hearing` scenarios.
 *
 * Mirrors `libs/core/training-catalog.ts`'s `defineCatalog` pattern. Each
 * entry names the requirement set a hearing session walks through, which
 * canvas renderer owns the read-only preview (`web_app_preview`, the
 * existing model-drawn/template canvas in
 * `presence/displays/presence-studio/hearing-canvas.ts` +
 * `hearing-runtime.ts`'s `renderHearingCanvas`; `work_inventory_table`, the
 * deterministic table canvas in
 * `presence/displays/presence-studio/hearing-work-inventory.ts`), and which
 * governed hand-off the decided record confirms into
 * (`mission` via `hearing-mission-routes.ts`, `work_inventory` via the
 * `POST /api/hearing/:session/inventory` route in `hearing-routes.ts`).
 *
 * `presence/displays/presence-studio/hearing.ts`'s `WEB_APP_HEARING_SCENARIO`
 * is a thin derived constant read from this catalog's `web_app_build`
 * entry — the catalog is the single source of truth for that requirement
 * set, not a duplicate literal.
 *
 * An entry may also group its requirements into ordered `phases` — a hearing
 * sheet (FRONT_DESK_HEARING_TRAINING_PLAN §2.2, revised 2026-09-14 after real
 * use: a hearing that only fills "the next empty slot" on every message loops
 * forever; a sheet says, per phase, what must be decided, and is done when
 * every item of every phase has an answer). `default_scenario` names the sheet
 * a new session opens on.
 */
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export type HearingScenarioCanvasKind = 'web_app_preview' | 'work_inventory_table';

export type HearingScenarioHandoffKind = 'mission' | 'work_inventory';

export interface HearingScenarioCatalogRequirement {
  id: string;
  /** A `front_desk:*` vocabulary key, never raw display text — see
   * `presence/displays/presence-studio/hearing.ts`'s
   * `HearingScenarioRequirement.label_key` doc for the i18n-gate reason. */
  label_key: string;
  aliases?: string[];
}

export interface HearingScenarioCatalogPhase {
  id: string;
  /** A `front_desk:*` vocabulary key. */
  title_key: string;
  requirement_ids: string[];
}

export interface HearingScenarioCatalogEntry {
  id: string;
  label_key: string;
  description_key: string;
  requirements: HearingScenarioCatalogRequirement[];
  /** Ordered hearing-sheet phases; absent for a flat scenario. */
  phases?: HearingScenarioCatalogPhase[];
  canvas: HearingScenarioCanvasKind;
  handoff: HearingScenarioHandoffKind;
}

export interface HearingScenarioCatalog {
  version: string;
  default_scenario?: string;
  scenarios: HearingScenarioCatalogEntry[];
}

const catalog = defineCatalog<HearingScenarioCatalog>({
  id: 'hearing-scenarios',
  path: pathResolver.rootResolve('knowledge/product/orchestration/hearing-scenarios.json'),
  schema: pathResolver.rootResolve('knowledge/product/schemas/hearing-scenarios.schema.json'),
});

export function loadHearingScenarios(): HearingScenarioCatalog {
  return catalog.load();
}

export function findHearingScenario(id: string): HearingScenarioCatalogEntry | undefined {
  return loadHearingScenarios().scenarios.find((scenario) => scenario.id === id);
}

/** The scenario a new session opens on: `default_scenario`, else the first entry. */
export function defaultHearingScenario(): HearingScenarioCatalogEntry {
  const loaded = loadHearingScenarios();
  const id = loaded.default_scenario;
  const found = id ? loaded.scenarios.find((scenario) => scenario.id === id) : loaded.scenarios[0];
  if (!found) throw new Error('[HEARING_SCENARIOS] default_scenario is not in the catalog');
  return found;
}

/**
 * Requirement id → phase id for an entry's sheet. Throws when a phase names an
 * unknown requirement or a requirement sits in two phases — the schema cannot
 * express either, and a sheet that silently drops or doubles an item never
 * completes the way it reads.
 */
export function hearingRequirementPhases(entry: HearingScenarioCatalogEntry): Map<string, string> {
  const known = new Set(entry.requirements.map((item) => item.id));
  const phaseOf = new Map<string, string>();
  for (const phase of entry.phases ?? []) {
    for (const requirementId of phase.requirement_ids) {
      if (!known.has(requirementId)) {
        throw new Error(
          `[HEARING_SCENARIOS] ${entry.id}.${phase.id} names unknown requirement ${requirementId}`
        );
      }
      if (phaseOf.has(requirementId)) {
        throw new Error(
          `[HEARING_SCENARIOS] ${entry.id}: requirement ${requirementId} is in two phases`
        );
      }
      phaseOf.set(requirementId, phase.id);
    }
  }
  return phaseOf;
}

export interface HearingPhaseProgress {
  id: string;
  title_key: string;
  complete: number;
  total: number;
  /** Position of this phase in the sheet, 1-based. */
  index: number;
  count: number;
}

/**
 * Per-phase coverage for a record whose requirements carry `phase_id`. The
 * current phase is the first one with an unanswered item; `null` once the
 * sheet is complete. Records from before phases existed (no `phase_id`) are
 * reported as a single unnamed phase so old sessions keep working.
 */
export function hearingPhaseProgress(
  requirements: ReadonlyArray<{ id: string; phase_id?: string; answer?: string }>,
  phases: ReadonlyArray<{ id: string; title_key: string }>
): { phases: HearingPhaseProgress[]; current: HearingPhaseProgress | null } {
  const known = phases.length
    ? phases
    : [{ id: 'all', title_key: 'front_desk:hearing_title' as const }];
  const progress: HearingPhaseProgress[] = known.map((phase, index) => {
    const items = requirements.filter((item) =>
      phases.length ? item.phase_id === phase.id : true
    );
    return {
      id: phase.id,
      title_key: phase.title_key,
      complete: items.filter((item) => item.answer?.trim()).length,
      total: items.length,
      index: index + 1,
      count: known.length,
    };
  });
  const current = progress.find((phase) => phase.complete < phase.total) ?? null;
  return { phases: progress, current };
}
