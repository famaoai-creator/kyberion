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

const FALLBACK_CATALOG: TrackerSheetPolicyCatalog = {
  version: '1.0.0',
  sheet_titles: {
    overview: 'Overview',
    execution_board: 'Execution Board',
    signals: 'Signals and Risks',
  },
  summary_empty_message: 'No summary cards provided.',
};

const catalog = defineCatalog<TrackerSheetPolicyCatalog>({
  id: 'tracker-sheet-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadTrackerSheetPolicyCatalog(): TrackerSheetPolicyCatalog {
  return catalog.load();
}
