import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPersistedTrustLedger } from './trust-engine.js';

describe('persisted trust ledger catalog', () => {
  it('loads a personal-tier trust ledger through the governed catalog', () => {
    const root = path.join(process.cwd(), 'active/shared/tmp', `trust-ledger-${Date.now()}`);
    const ledgerPath = path.join(root, 'knowledge/personal/governance/agent-trust-scores.json');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        'Agent-Fixture': {
          current_score: 200,
          tier: 3,
          dimensions: {
            policyCompliance: 40,
            securityPosture: 40,
            outputQuality: 40,
            resourceEfficiency: 40,
            collaborationHealth: 40,
          },
          last_updated: '2026-08-27T23:01:07.332Z',
        },
      })
    );
    try {
      const ledger = loadPersistedTrustLedger(root);
      expect(ledger?.['Agent-Fixture']?.current_score).toBe(200);
      expect(ledger?.['Agent-Fixture']?.dimensions.policyCompliance).toBe(40);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed existing ledger instead of returning an empty grant set', () => {
    const root = path.join(
      process.cwd(),
      'active/shared/tmp',
      `trust-ledger-invalid-${Date.now()}`
    );
    const ledgerPath = path.join(root, 'knowledge/personal/governance/agent-trust-scores.json');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({ 'Agent-Fixture': { current_score: -1 } }));
    try {
      expect(() => loadPersistedTrustLedger(root)).toThrow(/Invalid catalog agent-trust-scores/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
