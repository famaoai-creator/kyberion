import { describe, expect, it } from 'vitest';
import {
  changeWorkspaceSelection,
  workspaceQuery,
  workspaceSectionHref,
  workspaceSelectionFromQuery,
} from './workspace-query.js';

describe('workspace navigation hints', () => {
  it('roundtrips canonical hierarchy and operation between surface query styles', () => {
    const selection = {
      tenant_slug: 'acme',
      organization_id: 'sales',
      operation_id: 'followup',
      tier: 'confidential' as const,
    };
    expect(workspaceSelectionFromQuery(workspaceQuery(selection, 'camel'))).toEqual(selection);
    const target = new URL(workspaceSectionHref('approvals', selection), 'https://example.test');
    expect(target.searchParams.get('operation_id')).toBe('followup');
    expect(target.searchParams.get('organization_id')).toBe('sales');
    expect(target.searchParams.get('section')).toBe('approvals');
  });

  it('clears descendant and row selections on a real parent switch', () => {
    const query = new URLSearchParams(
      'tenant=acme&organization_id=sales&project_id=one&candidateKey=old&request=old&storageChannel=terminal&section=knowledge'
    );
    const next = changeWorkspaceSelection(query, 'tenant', 'other');
    expect(Object.fromEntries(next)).toEqual({ tenant: 'other', section: 'knowledge' });
    expect(changeWorkspaceSelection(query, 'tenant', 'acme').get('candidateKey')).toBe('old');
  });

  it('treats project and operation as mutually exclusive without dropping organization', () => {
    const query = new URLSearchParams('tenant=acme&organizationId=sales&projectId=one&request=old');
    const next = changeWorkspaceSelection(query, 'operation_id', 'routine');
    expect(Object.fromEntries(next)).toEqual({
      tenant: 'acme',
      organization_id: 'sales',
      operation_id: 'routine',
    });
    const project = changeWorkspaceSelection(next, 'project_id', 'two');
    expect(project.has('operation_id')).toBe(false);
    expect(project.get('organization_id')).toBe('sales');
  });
});
