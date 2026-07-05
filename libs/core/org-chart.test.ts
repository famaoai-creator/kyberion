import { afterEach, describe, expect, it } from 'vitest';
import { resolveOrganizationOrgChart } from './org-chart.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('org-chart', () => {
  const tmpRoot = pathResolver.sharedTmp('org-chart-resolver-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('derives a default org chart from the team-role catalog', () => {
    safeMkdir(`${tmpRoot}/knowledge/product/personalities`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/product/orchestration`, { recursive: true });
    safeMkdir(`${tmpRoot}/knowledge/product/governance`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/knowledge/product/personalities/roles.json`,
      JSON.stringify(
        {
          domains: {
            1: { name: 'Leadership & Strategy', roles: { 1: 'CEO', 2: 'Business Owner' } },
            2: { name: 'Engineering & Operations', roles: { 1: 'Software Developer' } },
          },
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/knowledge/product/orchestration/team-role-index.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          team_roles: {
            owner: {
              description: 'Owns the mission.',
              required_capabilities: ['reasoning'],
              compatible_authority_roles: ['mission_controller'],
              allowed_delegate_team_roles: [],
              escalation_parent_team_role: null,
              required_scope_classes: ['mission_state'],
              ownership_scope: 'Owns the mission.',
              autonomy_level: 'high',
            },
            planner: {
              description: 'Plans the work.',
              required_capabilities: ['reasoning'],
              compatible_authority_roles: ['mission_controller'],
              allowed_delegate_team_roles: [],
              escalation_parent_team_role: 'owner',
              required_scope_classes: ['mission_state'],
              ownership_scope: 'Owns the plan.',
              autonomy_level: 'medium',
            },
          },
        },
        null,
        2
      )
    );
    safeWriteFile(
      `${tmpRoot}/knowledge/product/governance/authority-role-index.json`,
      JSON.stringify(
        {
          authority_roles: {
            mission_controller: {
              description: 'Mission control.',
              write_scopes: ['active/missions/'],
              scope_classes: ['mission_state'],
              allowed_actuators: ['artifact-actuator'],
              tier_access: ['public', 'confidential'],
            },
          },
        },
        null,
        2
      )
    );

    const chart = resolveOrganizationOrgChart('acme', tmpRoot);

    expect(chart.organization_id).toBe('acme');
    expect(chart.source_kind).toBe('derived');
    expect(chart.positions.map((position) => position.role_id)).toEqual(['owner', 'planner']);
    expect(chart.positions[0].held_by).toBe('human');
    expect(chart.positions[1].reports_to).toBe('owner');
    expect(chart.domains.some((domain) => domain.name === 'Leadership & Strategy')).toBe(true);
  });

  it('loads an explicit org chart when present', () => {
    safeMkdir(`${tmpRoot}/customer/acme`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/customer/acme/org-chart.json`,
      JSON.stringify(
        {
          version: '1.0.0',
          organization_id: 'acme',
          name: 'ACME Org Chart',
          source_kind: 'customer',
          source_path: 'placeholder',
          domains: [
            { domain_id: 'leadership_strategy', name: 'Leadership & Strategy', role_ids: ['ceo'] },
          ],
          positions: [
            {
              role_id: 'ceo',
              reports_to: null,
              held_by: 'human',
              responsibility_scope: 'Sets direction.',
              authority_role_ref: 'ecosystem_architect',
            },
          ],
        },
        null,
        2
      )
    );

    const chart = resolveOrganizationOrgChart('acme', tmpRoot);

    expect(chart.source_kind).toBe('customer');
    expect(chart.name).toBe('ACME Org Chart');
    expect(chart.positions).toHaveLength(1);
    expect(chart.domains[0].role_ids).toEqual(['ceo']);
  });
});
