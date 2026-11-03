import { describe, expect, it } from 'vitest';
import {
  buildOrganizationFlowProps,
  organizationHealthLabel,
  organizationReadinessLabel,
  organizationInterventionCommand,
} from './OrganizationOperatingModel';

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

  it('shows a tenant-scoped next command for an incident', () => {
    expect(organizationInterventionCommand('incident', 'INC-1', 'ORG-1', 'acme')).toBe(
      'pnpm organization incident list --organization-id ORG-1 --tier confidential --tenant-slug acme --incident-id INC-1 --json'
    );
    expect(organizationInterventionCommand('operation', 'OP-1:target', 'ORG-1', 'acme')).toContain(
      '--operation-id OP-1 --json'
    );
  });
});

describe('OrganizationOperatingModel structure flow (UI-07 wave 3b)', () => {
  it('links domains → capabilities → services with service health', () => {
    const flow = buildOrganizationFlowProps(
      {
        domains: [{ domain_id: 'd', name: 'Delivery', capability_ids: ['c'], service_ids: ['s'] }],
        capabilities: [{ capability_id: 'c', name: 'Build', service_ids: ['s'] }],
        services: [{ service_id: 's', name: 'Web', outcome: 'o', status: 'active' }],
        service_states: [{ service_id: 's', health: 'degraded' }],
      },
      'en'
    );
    expect(flow.nodes.map((node) => node.stage)).toEqual(['domain', 'capability', 'service']);
    expect(flow.nodes[2]).toMatchObject({ status: 'degraded', meta: 'degraded' });
    expect(flow.edges).toEqual([
      { from: 'domain:d', to: 'capability:c' },
      { from: 'capability:c', to: 'service:s' },
    ]);
  });
});
