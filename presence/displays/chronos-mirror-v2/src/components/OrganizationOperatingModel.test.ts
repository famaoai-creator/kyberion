import { describe, expect, it } from 'vitest';
import { organizationHealthLabel, organizationReadinessLabel } from './OrganizationOperatingModel';

describe('OrganizationOperatingModel presentation helpers', () => {
  it('maps readiness to operator-facing states', () => {
    expect(
      organizationReadinessLabel(
        { purpose: 'approved', operational_state: 'available', pending_human_decisions: 0 },
        'en'
      )
    ).toBe('ready');
    expect(
      organizationReadinessLabel(
        { purpose: 'draft', operational_state: 'available', pending_human_decisions: 0 },
        'ja'
      )
    ).toBe('目的を確認中');
  });

  it('uses the localized service-health labels', () => {
    expect(organizationHealthLabel('healthy', 'en')).toBe('healthy');
    expect(organizationHealthLabel('critical', 'ja')).toBe('重大');
    expect(organizationHealthLabel('unexpected', 'en')).toBe('unknown');
  });
});
