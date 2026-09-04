import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface TrackerSheetPolicyCatalog {
  version: string;
  sheet_titles: {
    overview: string;
    execution_board: string;
    signals: string;
  };
  summary_empty_message: string;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/tracker-sheet-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/tracker-sheet-policy.schema.json');

const catalog = defineCatalog<TrackerSheetPolicyCatalog>({
  id: 'tracker-sheet-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadTrackerSheetPolicyCatalog(): TrackerSheetPolicyCatalog {
  return catalog.load();
}
