import { describe, expect, it } from 'vitest';

import { loadMissionLedgerPolicyCatalog, resolveMissionLedgerPolicy } from './mission-ledger-policy.js';

describe('mission-ledger-policy', () => {
  it('loads the canonical mission ledger table labels', () => {
    const catalog = loadMissionLedgerPolicyCatalog();
    expect(catalog.section_title).toBe('Mission Ledger');
    expect(catalog.table_headers.mission_id).toBe('Mission ID');
    expect(catalog.table_headers.traceability_refs).toBe('Traceability Refs');
  });

  it('resolves the policy object', () => {
    expect(resolveMissionLedgerPolicy().table_headers.gate_impact).toBe('Gate Impact');
  });
});
