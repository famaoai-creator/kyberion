import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface MissionLedgerPolicyCatalog {
  version: string;
  section_title: string;
  table_headers: {
    mission_id: string;
    relationship: string;
    status: string;
    summary: string;
    affected_artifacts: string;
    gate_impact: string;
    traceability_refs: string;
  };
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/mission-ledger-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-ledger-policy.schema.json');

const FALLBACK_CATALOG: MissionLedgerPolicyCatalog = {
  version: '1.0.0',
  section_title: 'Mission Ledger',
  table_headers: {
    mission_id: 'Mission ID',
    relationship: 'Relationship',
    status: 'Status',
    summary: 'Summary',
    affected_artifacts: 'Affected Artifacts',
    gate_impact: 'Gate Impact',
    traceability_refs: 'Traceability Refs',
  },
};

const catalog = defineCatalog<MissionLedgerPolicyCatalog>({
  id: 'mission-ledger-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadMissionLedgerPolicyCatalog(): MissionLedgerPolicyCatalog {
  return catalog.load();
}

export function resolveMissionLedgerPolicy(): MissionLedgerPolicyCatalog {
  return loadMissionLedgerPolicyCatalog();
}
