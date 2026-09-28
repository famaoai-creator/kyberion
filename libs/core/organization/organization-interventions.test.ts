import { describe, expect, it } from 'vitest';
import {
  createOrganizationIncident,
  transitionOrganizationIncident,
  transitionOrganizationDecision,
} from './organization-interventions.js';
import type { OrganizationDecisionRecord } from './organization-operating-model.js';

describe('organization interventions', () => {
  it('requires a review before closing an incident', () => {
    const incident = createOrganizationIncident({
      incidentId: 'INC-1',
      organizationId: 'ORG-1',
      tier: 'public',
      title: 'Failure',
      severity: 'high',
      ownerRole: 'operator',
      impactSummary: 'Service unavailable',
    });
    const triaging = transitionOrganizationIncident(incident, 'triaging', {});
    const resolved = transitionOrganizationIncident(triaging, 'resolved', {});
    expect(() => transitionOrganizationIncident(resolved, 'closed', {})).toThrow(/review/);
    expect(
      transitionOrganizationIncident(resolved, 'closed', { postIncidentReviewRef: 'review:INC-1' })
        .status
    ).toBe('closed');
  });

  it('requires approval evidence before an approved decision', () => {
    const decision = {
      version: '1.0.0',
      decision_id: 'DEC-1',
      organization_id: 'ORG-1',
      cadence_id: 'CAD-1',
      title: 'Proceed?',
      status: 'pending_approval',
      decision_owner: 'operator',
      due_at: '2026-10-01T00:00:00.000Z',
      options: ['yes', 'no'],
      follow_up_refs: [],
      tier: 'public',
      updated_at: '2026-09-24T00:00:00.000Z',
    } as OrganizationDecisionRecord;
    expect(() =>
      transitionOrganizationDecision(decision, 'approved', {
        chosenOption: 'yes',
        rationale: 'Safe',
      })
    ).toThrow(/approval reference/);
    expect(
      transitionOrganizationDecision(decision, 'approved', {
        chosenOption: 'yes',
        rationale: 'Safe',
        approvalRef: 'approval:abc',
      }).status
    ).toBe('approved');
  });
});
