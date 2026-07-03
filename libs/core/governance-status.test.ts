import { describe, expect, it } from 'vitest';

import { getGovernanceControlSummary } from './governance-status.js';

describe('governance-status', () => {
  it('summarizes control surface state', () => {
    const summary = getGovernanceControlSummary();

    expect(summary.approval_rules).toBeGreaterThan(0);
    expect(summary.shell_allow_rules).toBeGreaterThan(0);
    expect(summary.egress_allowlist_domains).toBeGreaterThan(0);
    expect(typeof summary.kill_switch_monitoring).toBe('boolean');
  });
});
