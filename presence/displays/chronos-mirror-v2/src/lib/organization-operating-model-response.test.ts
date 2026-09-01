import { describe, expect, it } from 'vitest';
import { parseOrganizationOperatingModelResponse } from './organization-operating-model-response';

const base = {
  organization_id: 'org-1',
  purpose: null,
  operational_state: { status: 'active' },
  domains: [],
  capabilities: [],
  services: [],
  service_states: [],
  operations: [],
  operation_states: [],
  incidents: [],
  decisions: [],
  solution_projects: [],
  learning_candidates: [],
  reconciliation: {
    status: 'ok',
    overdue_operations: [],
    stale_services: [],
    pending_decisions: [],
  },
  control_plane: {
    accounting: {
      active_projects: 0,
      active_services: 0,
      healthy_services: 0,
      degraded_or_critical_services: 0,
      active_operations: 0,
      overdue_operations: 0,
      open_incidents: 0,
      pending_decisions: 0,
    },
    intervention_points: [],
    outcome_accounting: { objectives: [] },
  },
  readiness: { purpose: 'missing', operational_state: 'missing', pending_human_decisions: 0 },
};

describe('organization operating model response boundary', () => {
  it('accepts the displayed projection and tenant identity', () => {
    expect(
      parseOrganizationOperatingModelResponse({
        view: base,
        tenant: { company_id: 'company-1', tenant_slug: 'tenant-a', name: 'Tenant A' },
      })
    ).toMatchObject({ view: { organization_id: 'org-1' }, tenant: { tenant_slug: 'tenant-a' } });
  });

  it('rejects malformed nested fields and dangerous keys', () => {
    expect(
      parseOrganizationOperatingModelResponse({ view: { ...base, control_plane: {} } })
    ).toBeUndefined();
    expect(
      parseOrganizationOperatingModelResponse(
        JSON.parse('{"view":{"__proto__":{},"organization_id":"org-1"}}')
      )
    ).toBeUndefined();
    expect(
      parseOrganizationOperatingModelResponse({
        view: { ...base, service_states: [{ service_id: 'service-1', health: 'unknown-value' }] },
      })
    ).toBeUndefined();
  });
});
