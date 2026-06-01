import { describe, expect, it } from 'vitest';

import { loadPilotStrategyPolicyCatalog, resolvePilotStrategyPolicy } from './pilot-strategy-policy.js';

describe('pilot-strategy-policy', () => {
  it('loads the canonical strategy labels', () => {
    const catalog = loadPilotStrategyPolicyCatalog();
    expect(catalog.title).toBe('Kyberion AI Consulting: Go-to-Market Strategy');
    expect(catalog.target).toBe('Japanese Mid-sized Enterprise (SMB) Managers');
    expect(catalog.phase_titles.education).toBe('Education');
  });

  it('resolves the policy object', () => {
    expect(resolvePilotStrategyPolicy().key_benefits_title).toBe('Key Benefits');
  });
});
