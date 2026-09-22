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

export interface HearingScenarioCatalogEntry {
  id: string;
  label_key: string;
  description_key: string;
  requirements: HearingScenarioCatalogRequirement[];
  canvas: HearingScenarioCanvasKind;
  handoff: HearingScenarioHandoffKind;
}

export interface HearingScenarioCatalog {
  version: string;
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
