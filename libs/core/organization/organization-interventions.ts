import { nowIso } from '../foundation/time.js';
import {
  validateOrganizationDecision,
  validateOrganizationIncident,
  validateOrganizationLearningCandidate,
} from './organization-operating-model-persistence.js';
import type {
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationLearningCandidate,
  OrganizationTier,
} from './organization-operating-model.js';

export function createOrganizationIncident(
  input: {
    incidentId: string;
    organizationId: string;
    tier: OrganizationTier;
    tenantSlug?: string;
    title: string;
    severity: OrganizationIncidentRecord['severity'];
    ownerRole: string;
    impactSummary: string;
    serviceId?: string;
    operationId?: string;
    triggerRefs?: string[];
  },
  now = nowIso()
): OrganizationIncidentRecord {
  if (input.tier === 'confidential' && !input.tenantSlug)
    throw new Error('Confidential incident requires a tenant.');
  const incident: OrganizationIncidentRecord = {
    version: '1.0.0',
    incident_id: input.incidentId,
    organization_id: input.organizationId,
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    title: input.title,
    severity: input.severity,
    status: 'detected',
    owner_role: input.ownerRole,
    impact_summary: input.impactSummary,
    ...(input.serviceId ? { service_id: input.serviceId } : {}),
    ...(input.operationId ? { operation_id: input.operationId } : {}),
    ...(input.triggerRefs?.length ? { trigger_refs: input.triggerRefs } : {}),
    created_at: now,
    updated_at: now,
  };
  if (!validateOrganizationIncident(incident)) throw new Error('Invalid organization incident.');
  return incident;
}

const INCIDENT_NEXT: Record<
  OrganizationIncidentRecord['status'],
  OrganizationIncidentRecord['status'][]
> = {
  detected: ['triaging'],
  triaging: ['mitigating', 'resolved'],
  mitigating: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

const INCIDENT_LIFECYCLE = 'detected -> triaging -> mitigating -> resolved -> closed';

function describeIncidentTransition(
  current: OrganizationIncidentRecord['status'],
  status: OrganizationIncidentRecord['status']
): string {
  const allowed = INCIDENT_NEXT[current];
  return (
    `Invalid incident transition: ${current} -> ${status}. ` +
    `Allowed next states from '${current}': ${allowed.length > 0 ? allowed.join(', ') : '(terminal — no further transitions)'}. ` +
    `Lifecycle: ${INCIDENT_LIFECYCLE}.`
  );
}

export function transitionOrganizationIncident(
  current: OrganizationIncidentRecord,
  status: OrganizationIncidentRecord['status'],
  input: { impactSummary?: string; mitigationMissionId?: string; postIncidentReviewRef?: string },
  now = nowIso()
): OrganizationIncidentRecord {
  if (!INCIDENT_NEXT[current.status].includes(status))
    throw new Error(describeIncidentTransition(current.status, status));
  if (status === 'closed' && !(input.postIncidentReviewRef || current.post_incident_review_ref)) {
    throw new Error('Closing an incident requires a post-incident review reference.');
  }
  const incident: OrganizationIncidentRecord = {
    ...current,
    status,
    ...(input.impactSummary ? { impact_summary: input.impactSummary } : {}),
    ...(input.mitigationMissionId ? { mitigation_mission_id: input.mitigationMissionId } : {}),
    ...(input.postIncidentReviewRef
      ? { post_incident_review_ref: input.postIncidentReviewRef }
      : {}),
    updated_at: now,
  };
  if (!validateOrganizationIncident(incident))
    throw new Error('Invalid organization incident transition.');
  return incident;
}

const DECISION_NEXT: Record<
  OrganizationDecisionRecord['status'],
  OrganizationDecisionRecord['status'][]
> = {
  proposed: ['pending_approval', 'deferred'],
  pending_approval: ['approved', 'rejected', 'deferred'],
  approved: ['implemented'],
  rejected: [],
  deferred: ['pending_approval'],
  implemented: [],
};

const DECISION_LIFECYCLE =
  'proposed -> pending_approval -> approved -> implemented (side branches: proposed/pending_approval -> deferred -> pending_approval; pending_approval -> rejected [terminal])';

function describeDecisionTransition(
  current: OrganizationDecisionRecord['status'],
  status: OrganizationDecisionRecord['status']
): string {
  const allowed = DECISION_NEXT[current];
  return (
    `Invalid decision transition: ${current} -> ${status}. ` +
    `New decisions always start as proposed; advance one step at a time. ` +
    `Allowed next states from '${current}': ${allowed.length > 0 ? allowed.join(', ') : '(terminal — no further transitions)'}. ` +
    `Lifecycle: ${DECISION_LIFECYCLE}.`
  );
}

export function transitionOrganizationDecision(
  current: OrganizationDecisionRecord,
  status: OrganizationDecisionRecord['status'],
  input: {
    chosenOption?: string;
    rationale?: string;
    approvalRef?: string;
    followUpRefs?: string[];
  },
  now = nowIso()
): OrganizationDecisionRecord {
  if (!DECISION_NEXT[current.status].includes(status))
    throw new Error(describeDecisionTransition(current.status, status));
  const chosenOption = input.chosenOption || current.chosen_option;
  const rationale = input.rationale || current.rationale;
  if (chosenOption && !current.options.includes(chosenOption))
    throw new Error('Chosen option is not a declared option.');
  if (['approved', 'rejected'].includes(status) && (!rationale || !input.approvalRef)) {
    throw new Error(
      'Decision approval or rejection requires rationale and a verified approval reference.'
    );
  }
  if (status === 'approved' && !chosenOption)
    throw new Error('Approved decision requires a chosen option.');
  if (status === 'implemented' && !(input.followUpRefs?.length || current.follow_up_refs.length)) {
    throw new Error('Implemented decision requires a follow-up reference.');
  }
  const decision: OrganizationDecisionRecord = {
    ...current,
    status,
    ...(chosenOption ? { chosen_option: chosenOption } : {}),
    ...(rationale ? { rationale } : {}),
    ...(input.approvalRef
      ? { approval_refs: [...new Set([...(current.approval_refs || []), input.approvalRef])] }
      : {}),
    follow_up_refs: [...new Set([...current.follow_up_refs, ...(input.followUpRefs || [])])],
    updated_at: now,
  };
  if (!validateOrganizationDecision(decision))
    throw new Error('Invalid organization decision transition.');
  return decision;
}

const LEARNING_NEXT: Record<
  OrganizationLearningCandidate['status'],
  OrganizationLearningCandidate['status'][]
> = {
  proposed: ['approved', 'rejected'],
  approved: ['promoted', 'rejected'],
  rejected: [],
  promoted: [],
};

/**
 * Advances a learning candidate: proposed -> approved -> promoted, or -> rejected.
 * Rejection needs a note; promotion needs the knowledge/ document it landed in,
 * whose existence and tier the caller verifies.
 */
export function transitionOrganizationLearningCandidate(
  current: OrganizationLearningCandidate,
  status: OrganizationLearningCandidate['status'],
  input: { note?: string; promotedRef?: string },
  now = nowIso()
): OrganizationLearningCandidate {
  const allowed = LEARNING_NEXT[current.status];
  if (!allowed.includes(status))
    throw new Error(
      `Invalid learning transition: ${current.status} -> ${status}. ` +
        `Allowed next states from '${current.status}': ${allowed.length > 0 ? allowed.join(', ') : '(terminal — no further transitions)'}. ` +
        'Lifecycle: proposed -> approved -> promoted (proposed/approved -> rejected [terminal]).'
    );
  if (status === 'rejected' && !input.note)
    throw new Error('Rejecting a learning candidate requires --reason <why>.');
  if (status === 'promoted' && !input.promotedRef)
    throw new Error(
      'Promoting a learning candidate requires --promoted-ref <knowledge/... document it landed in>.'
    );
  const record: OrganizationLearningCandidate = {
    ...current,
    status,
    ...(input.note ? { decision_note: input.note } : {}),
    ...(input.promotedRef ? { promoted_ref: input.promotedRef } : {}),
    updated_at: now,
  };
  if (!validateOrganizationLearningCandidate(record))
    throw new Error('Invalid organization learning candidate transition.');
  return record;
}
