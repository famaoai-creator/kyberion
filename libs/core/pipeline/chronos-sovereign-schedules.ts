/**
 * Chronos sovereign schedule allowlist — a governed catalog, not code.
 *
 * Repository-lane schedules are system jobs; a small subset must read
 * cross-tenant or confidential data and therefore run under the sovereign
 * persona. The ids live in
 * `knowledge/product/governance/chronos-sovereign-schedules.json` so the
 * privilege decision stays an explicit, reviewable file change instead of
 * a daemon edit. The daemon's configured base role still gates everything:
 * a non-sovereign daemon ignores the list entirely.
 */
import * as nodePath from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver, rootDir } from '../path-resolver.js';
import { logger } from '../core.js';

export const SOVEREIGN_SCHEDULES_CATALOG_PATH =
  'knowledge/product/governance/chronos-sovereign-schedules.json';

const SOVEREIGN_SCHEDULES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/chronos-sovereign-schedules.schema.json'
);

interface SovereignScheduleCatalog {
  version: '1.0';
  schedule_ids: string[];
}

const catalog = defineCatalog<SovereignScheduleCatalog>({
  id: 'chronos-sovereign-schedules',
  path: () => nodePath.join(rootDir(), SOVEREIGN_SCHEDULES_CATALOG_PATH),
  schema: SOVEREIGN_SCHEDULES_SCHEMA_PATH,
});

/**
 * The declared sovereign schedule ids. A missing or invalid catalog
 * fails closed (empty set — nothing runs sovereign) with a warning,
 * never silently widens authority.
 */
export function sovereignScheduleIds(): ReadonlySet<string> {
  try {
    return new Set(catalog.load().schedule_ids);
  } catch (error) {
    logger.warn(
      `[chronos-sovereign-schedules] catalog unavailable — no schedule will run sovereign: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Set();
  }
}
