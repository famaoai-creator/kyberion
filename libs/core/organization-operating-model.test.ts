import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  buildOrganizationDomainRecord,
  buildOrganizationLearningCandidate,
  buildOrganizationManagementView,
  buildOrganizationObjectiveAddition,
  buildOrganizationOperationRecord,
  buildOrganizationProjectLink,
  buildOrganizationScaffold,
  buildOrganizationServiceAddition,
  saveProjectRecord,
  loadOrganizationCatalog,
  loadOrganizationOperatingModelCatalog,
  loadOrganizationOperationalState,
  listOrganizationOperationRuns,
  listOrganizationOperationStates,
  listOrganizationOperations,
  reconcileOrganizationCatalog,
  reconcileOrganizationState,
  resolveOrganizationWork,
  saveOrganizationCapability,
  saveOrganizationDomain,
  saveOrganizationOperationalState,
  saveOrganizationPurpose,
  saveOrganizationService,
  saveOrganizationServiceState,
  saveOrganizationOperation,
  saveOrganizationOperationRun,
  saveOrganizationOperationState,
  saveOrganizationLearningCandidate,
  saveOrganizationIncident,
  saveOrganizationDecision,
  t,
  type OrganizationCapabilityRecord,
  type OrganizationDomainRecord,
  type OrganizationOperationalState,
  type OrganizationOperationRecord,
  type OrganizationOperationRun,
  type OrganizationOperationState,
  type OrganizationLearningCandidate,
  type OrganizationPurposeRecord,
  type OrganizationServiceRecord,
  type OrganizationServiceState,
} from '@agent/core';
import { pathResolver, safeRmSync } from '@agent/core';

const organizationId = 'org-operating-model-test';
const tenantSlug = 'tenant-acme';
const workspace = pathResolver.organizationWorkspaceDir(organizationId, 'confidential', tenantSlug);

describe('organization operating model', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.KYBERION_SUDO = 'true';
    process.env.KYBERION_TENANT = tenantSlug;
    safeRmSync(workspace);
  });

  afterEach(() => {
    process.env.KYBERION_SUDO = 'true';
    safeRmSync(workspace);
    process.env = { ...originalEnv };
  });

  it('loads the six organization work shapes and representative scenarios', () => {
    const catalog = loadOrganizationOperatingModelCatalog();
    expect(catalog.work_shapes).toHaveLength(6);
    expect(catalog.resolution_examples).toHaveLength(6);
    expect(catalog.work_shapes.map((shape) => shape.id)).toContain('routine_operation');
    expect(catalog.work_shapes.map((shape) => shape.id)).toContain('solution_project');
  });

  it('persists purpose and operational state in the tenant-scoped confidential workspace', () => {
    const purpose: OrganizationPurposeRecord = {
      version: '1.0.0',
      organization_id: organizationId,
      name: 'Operating Model Test',
      purpose: 'Keep organizational work explicit.',
      principles: ['Make ownership visible.'],
      tier: 'confidential',
      tenant_slug: tenantSlug,
      owner_role: 'organization_owner',
      approval_state: 'approved',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const state: OrganizationOperationalState = {
      organization_id: organizationId,
      name: purpose.name,
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      active_operation_ids: ['monthly-billing'],
      pending_decision_ids: ['decision-1'],
      updated_at: '2026-08-03T00:00:00.000Z',
    };

    expect(saveOrganizationPurpose(purpose)).toContain('purpose.json');
    expect(saveOrganizationOperationalState(state)).toContain('organization-state.json');
    expect(
      loadOrganizationOperationalState(organizationId, { tier: 'confidential', tenantSlug })
    ).toEqual(state);

    const view = buildOrganizationManagementView({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(view.purpose?.approval_state).toBe('approved');
    expect(view.operational_state?.active_operation_ids).toEqual(['monthly-billing']);
    expect(view.readiness.pending_human_decisions).toBe(1);
    expect(view.control_plane.accounting.active_projects).toBe(0);
    expect(view.control_plane.accounting.pending_decisions).toBe(1);
  });

  it('keeps the organization management view inside its supplied root', () => {
    const rootDir = pathResolver.sharedTmp('organization-root-isolation-test');
    const isolatedOrganizationId = 'org-root-isolation-test';
    const isolatedTenant = 'tenant-root-isolation';
    safeRmSync(rootDir, { recursive: true, force: true });
    try {
      const state: OrganizationOperationalState = {
        organization_id: isolatedOrganizationId,
        name: 'Root Isolated Organization',
        tier: 'confidential',
        tenant_slug: isolatedTenant,
        status: 'active',
        updated_at: '2026-08-03T00:00:00.000Z',
      };
      saveOrganizationOperationalState(state, { rootDir });
      saveOrganizationPurpose(
        {
          version: '1.0.0',
          organization_id: isolatedOrganizationId,
          name: state.name,
          purpose: 'Verify root-aware management views.',
          tier: 'confidential',
          tenant_slug: isolatedTenant,
          owner_role: 'operator',
          approval_state: 'approved',
          updated_at: state.updated_at,
        },
        { rootDir }
      );

      const view = buildOrganizationManagementView({
        organizationId: isolatedOrganizationId,
        tier: 'confidential',
        tenantSlug: isolatedTenant,
        rootDir,
      });

      expect(view.operational_state?.organization_id).toBe(isolatedOrganizationId);
      expect(view.purpose?.purpose).toBe('Verify root-aware management views.');
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a different tenant reads confidential organization state', () => {
    const state: OrganizationOperationalState = {
      organization_id: organizationId,
      name: 'Tenant Protected Organization',
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    saveOrganizationOperationalState(state);
    process.env.KYBERION_SUDO = 'false';
    process.env.KYBERION_TENANT = 'tenant-other';

    expect(() =>
      loadOrganizationOperationalState(organizationId, { tier: 'confidential', tenantSlug })
    ).toThrow(/tenant|POLICY_VIOLATION/i);
  });

  it('requires tenant scope when writing confidential organization state', () => {
    expect(() =>
      saveOrganizationOperationalState({
        organization_id: organizationId,
        name: 'Unscoped Organization',
        tier: 'confidential',
        status: 'active',
        updated_at: '2026-08-03T00:00:00.000Z',
      })
    ).toThrow(/tenant_slug|required/i);
  });

  it('registers domain, capability, service, and health state, then detects broken references', () => {
    const domain: OrganizationDomainRecord = {
      version: '1.0.0',
      domain_id: 'customer-operations',
      organization_id: organizationId,
      name: 'Customer Operations',
      owner_role: 'customer_success',
      capability_ids: ['customer-support'],
      service_ids: ['customer-support-service'],
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const capability: OrganizationCapabilityRecord = {
      version: '1.0.0',
      capability_id: 'customer-support',
      organization_id: organizationId,
      domain_id: domain.domain_id,
      name: 'Customer Support',
      owner_role: 'customer_success',
      service_ids: ['customer-support-service'],
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const service: OrganizationServiceRecord = {
      version: '1.0.0',
      service_id: 'customer-support-service',
      organization_id: organizationId,
      domain_id: domain.domain_id,
      name: 'Customer Support Desk',
      outcome: 'Customers receive an accountable response.',
      owner_role: 'customer_success',
      consumers: ['customers'],
      slo: {
        target: 'First response within one business day',
        measurement_window: 'rolling_30_days',
        objective: 0.95,
        unit: 'fraction',
      },
      slis: [
        {
          sli_id: 'first-response-time',
          name: 'First response time',
          source_ref: 'service://customer-support/tickets',
          freshness_seconds: 3600,
        },
      ],
      runbook_refs: ['knowledge/product/orchestration/meeting-operations-playbook.md'],
      escalation_path: ['customer_success', 'incident_commander'],
      dependencies: [],
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const serviceState: OrganizationServiceState = {
      service_id: service.service_id,
      organization_id: organizationId,
      tier: 'confidential',
      tenant_slug: tenantSlug,
      health: 'healthy',
      observed_at: '2026-08-03T00:00:00.000Z',
      source_timestamp: '2026-08-03T00:00:00.000Z',
      freshness_seconds: 60,
      confidence: 0.95,
      reconcile_status: 'current',
      updated_at: '2026-08-03T00:00:00.000Z',
    };

    saveOrganizationDomain(domain);
    saveOrganizationCapability(capability);
    saveOrganizationService(service);
    saveOrganizationServiceState(serviceState);

    const catalog = loadOrganizationCatalog({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(catalog.domains).toHaveLength(1);
    expect(catalog.capabilities).toHaveLength(1);
    expect(catalog.services[0].slo.objective).toBe(0.95);
    expect(
      reconcileOrganizationCatalog({ organizationId, tier: 'confidential', tenantSlug })
    ).toMatchObject({
      status: 'clean',
      missing_capabilities: [],
      missing_services: [],
      services_without_state: [],
    });

    saveOrganizationDomain({
      ...domain,
      domain_id: 'broken-domain',
      capability_ids: ['missing-capability'],
      service_ids: ['missing-service'],
    });
    const reconciliation = reconcileOrganizationCatalog({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(reconciliation.status).toBe('attention');
    expect(reconciliation.missing_capabilities).toContain('broken-domain:missing-capability');
    expect(reconciliation.missing_services).toContain('broken-domain:missing-service');
  });

  it('tracks scheduled operations without turning them into projects', () => {
    const operation: OrganizationOperationRecord = {
      version: '1.0.0',
      operation_id: 'monthly-billing',
      organization_id: organizationId,
      service_id: 'billing-service',
      name: 'Monthly Billing',
      purpose: 'Process the monthly billing run and retain evidence.',
      operation_type: 'scheduled',
      owner_role: 'finance_controller',
      trigger: {
        kind: 'schedule',
        expression: '0 9 1 * *',
        timezone: 'Asia/Tokyo',
      },
      automation_boundary: {
        allowed_actions: ['prepare_report'],
        approval_required_actions: ['submit_invoice'],
        forbidden_actions: ['change_payment_account'],
      },
      escalation_path: ['finance_controller', 'governance_owner'],
      evidence_outputs: ['billing-report', 'billing-exception-log'],
      execution_target: { kind: 'task_session', ref: 'runbook:monthly-billing' },
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const operationState: OrganizationOperationState = {
      operation_id: operation.operation_id,
      organization_id: organizationId,
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'succeeded',
      due_status: 'current',
      last_run_at: '2026-08-01T00:00:00.000Z',
      next_due_at: '2026-09-01T00:00:00.000Z',
      last_result_summary: 'Billing run completed with no exceptions.',
      last_evidence_refs: ['knowledge/product/orchestration/meeting-operations-playbook.md'],
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const operationRun: OrganizationOperationRun = {
      run_id: 'monthly-billing-20260801',
      operation_id: operation.operation_id,
      organization_id: organizationId,
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'succeeded',
      started_at: '2026-08-01T00:00:00.000Z',
      completed_at: '2026-08-01T00:30:00.000Z',
      execution_ref: 'task-session:monthly-billing-20260801',
      result_summary: 'Billing run completed with no exceptions.',
      evidence_refs: ['knowledge/product/orchestration/meeting-operations-playbook.md'],
      recorded_at: '2026-08-01T00:31:00.000Z',
    };

    saveOrganizationOperation(operation);
    saveOrganizationOperationState(operationState);
    saveOrganizationOperationRun(operationRun);

    expect(
      listOrganizationOperations({ organizationId, tier: 'confidential', tenantSlug })
    ).toHaveLength(1);
    expect(
      listOrganizationOperationStates({ organizationId, tier: 'confidential', tenantSlug })
    ).toEqual([operationState]);
    expect(
      listOrganizationOperationRuns({ organizationId, tier: 'confidential', tenantSlug })
    ).toEqual([operationRun]);

    saveOrganizationOperation({
      ...operation,
      operation_id: 'orphan-operation',
      service_id: 'missing-service',
    });
    saveOrganizationOperation({
      ...operation,
      operation_id: 'invalid-target-operation',
      execution_target: { kind: 'pipeline', ref: 'pipelines/missing-operation.json' },
    });
    saveOrganizationOperationState({
      ...operationState,
      operation_id: 'invalid-target-operation',
      last_evidence_refs: ['active/shared/runtime/missing-operation-evidence.json'],
    });
    const reconciliation = reconcileOrganizationCatalog({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(reconciliation.status).toBe('attention');
    expect(reconciliation.missing_operation_services).toContain('orphan-operation:missing-service');
    expect(reconciliation.operations_without_state).toContain('orphan-operation');
    expect(reconciliation.invalid_execution_refs).toContain(
      'invalid-target-operation:pipelines/missing-operation.json'
    );
    expect(reconciliation.invalid_evidence_refs).toContain(
      'invalid-target-operation:active/shared/runtime/missing-operation-evidence.json'
    );
  });

  it('resolves organization work as a dry-run proposal with a human gate', () => {
    const routine = resolveOrganizationWork({
      utterance: '今月の運用レポートを作る',
      organizationId,
      tier: 'confidential',
      tenantSlug,
      locale: 'ja',
    });
    expect(routine).toMatchObject({
      work_shape: 'routine_operation',
      management_unit: 'operation',
      authority_class: 'normal',
      human_decision: 'pending',
      dry_run: true,
    });
    expect(routine.next_questions).toContain(
      t('organization:organization_resolution_parent_question', { parent: 'operation_id' }, 'ja')
    );

    const incident = resolveOrganizationWork({
      utterance: '本番障害を収束させる',
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(incident).toMatchObject({
      work_shape: 'incident_response',
      management_unit: 'incident',
      authority_class: 'high',
      human_decision: 'pending',
    });

    const governance = resolveOrganizationWork({
      utterance: 'SLOを変更する承認を行う',
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(governance).toMatchObject({
      work_shape: 'governance_cadence',
      management_unit: 'cadence',
      authority_class: 'approval_required',
      human_decision: 'pending',
    });
  });

  it('supports dry-run and apply reconciliation without copying project state', () => {
    const state: OrganizationOperationalState = {
      organization_id: organizationId,
      name: 'Reconciliation Test',
      tier: 'confidential',
      tenant_slug: tenantSlug,
      status: 'active',
      active_project_ids: ['missing-project'],
      active_operation_ids: ['stale-operation'],
      pending_decision_ids: ['stale-decision'],
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    const learning: OrganizationLearningCandidate = {
      version: '1.0.0',
      learning_id: 'learning-incident-1',
      organization_id: organizationId,
      source_type: 'incident_review',
      source_ref: 'incident-1',
      title: 'Incident review candidate',
      summary: 'Retain the corrected escalation sequence.',
      evidence_refs: ['active/shared/runtime/evidence/incident-1.json'],
      target_kind: 'sop_candidate',
      status: 'proposed',
      tier: 'confidential',
      tenant_slug: tenantSlug,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    };
    saveOrganizationOperationalState(state);
    saveOrganizationLearningCandidate(learning);

    const dryRun = reconcileOrganizationState({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(dryRun.mode).toBe('dry_run');
    expect(dryRun.actions).toHaveLength(1);
    expect(dryRun.updated_paths).toEqual([]);
    expect(dryRun.blocked_issues).toContain('missing_project_refs:missing-project');

    const applied = reconcileOrganizationState({
      organizationId,
      tier: 'confidential',
      tenantSlug,
      apply: true,
    });
    expect(applied.mode).toBe('apply');
    expect(applied.updated_paths).toHaveLength(1);
    expect(
      loadOrganizationOperationalState(organizationId, { tier: 'confidential', tenantSlug })
    ).toMatchObject({
      active_operation_ids: [],
      pending_decision_ids: [],
    });
    const view = buildOrganizationManagementView({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(view.learning_candidates).toEqual([learning]);
    expect(view.solution_projects).toEqual([]);
    expect(view.lineage.nodes).toContainEqual({
      id: `organization:${organizationId}`,
      kind: 'organization',
    });
    expect(view.control_plane.learning_refs).toContain('learning:learning-incident-1');
  });

  it('reconciles incidents and governance decisions as organization concerns', () => {
    saveOrganizationIncident({
      version: '1.0.0',
      incident_id: 'incident-1',
      organization_id: organizationId,
      service_id: 'missing-service',
      operation_id: 'missing-operation',
      title: 'Broken service incident',
      severity: 'high',
      status: 'triaging',
      owner_role: 'incident_commander',
      impact_summary: 'Service reference is unresolved.',
      tier: 'confidential',
      tenant_slug: tenantSlug,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    });
    saveOrganizationDecision({
      version: '1.0.0',
      decision_id: 'decision-1',
      organization_id: organizationId,
      cadence_id: 'missing-cadence',
      title: 'Approve operating boundary',
      status: 'pending_approval',
      decision_owner: 'organization_owner',
      due_at: '2026-08-10T00:00:00.000Z',
      options: ['approve', 'defer'],
      follow_up_refs: [],
      tier: 'confidential',
      tenant_slug: tenantSlug,
      updated_at: '2026-08-03T00:00:00.000Z',
    });

    const reconciliation = reconcileOrganizationCatalog({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(reconciliation).toMatchObject({
      status: 'attention',
      missing_incident_services: ['incident-1:missing-service'],
      missing_incident_operations: ['incident-1:missing-operation'],
      missing_decision_cadences: ['decision-1:missing-cadence'],
      pending_decisions: ['decision-1'],
    });
  });

  it('builds proposed learning candidates without promoting them automatically', () => {
    const candidate = buildOrganizationLearningCandidate(
      {
        learningId: 'learning-routine-1',
        organizationId,
        sourceType: 'routine_exception',
        sourceRef: 'monthly-billing:run-1',
        title: 'Routine exception candidate',
        summary: 'Capture the missing approval handoff as a reusable SOP candidate.',
        evidenceRefs: ['knowledge/product/orchestration/meeting-operations-playbook.md'],
        targetKind: 'sop_candidate',
        tier: 'confidential',
        tenantSlug,
      },
      '2026-08-03T00:00:00.000Z'
    );
    expect(candidate).toMatchObject({
      source_type: 'routine_exception',
      status: 'proposed',
      target_kind: 'sop_candidate',
      tenant_slug: tenantSlug,
    });
  });

  it('authors an organization end-to-end via the builder functions', () => {
    const now = '2026-08-08T00:00:00.000Z';
    const scaffold = buildOrganizationScaffold(
      {
        organizationId,
        name: 'Authored Organization',
        tier: 'confidential',
        tenantSlug,
        purpose: 'Prove the authoring path works without hand-editing JSON.',
        principles: ['Facade-only mutation.'],
        ownerRole: 'organization_owner',
      },
      now
    );
    expect(scaffold.state.active_project_ids).toEqual([]);
    expect(scaffold.purpose?.approval_state).toBe('draft');
    saveOrganizationOperationalState(scaffold.state);
    saveOrganizationPurpose(scaffold.purpose!);

    expect(() =>
      buildOrganizationScaffold(
        { organizationId, name: 'Duplicate', tier: 'confidential', tenantSlug },
        now
      )
    ).toThrow(/already exists/);

    const withObjective = buildOrganizationObjectiveAddition(
      {
        organizationId,
        tier: 'confidential',
        tenantSlug,
        objective: { objective_id: 'obj-authoring-1', title: 'First objective', status: 'active' },
      },
      now
    );
    expect(withObjective.objectives?.map((entry) => entry.objective_id)).toEqual([
      'obj-authoring-1',
    ]);
    saveOrganizationPurpose(withObjective);
    expect(() =>
      buildOrganizationObjectiveAddition(
        {
          organizationId,
          tier: 'confidential',
          tenantSlug,
          objective: { objective_id: 'obj-authoring-1', title: 'Duplicate objective' },
        },
        now
      )
    ).toThrow(/already exists/);

    expect(() =>
      buildOrganizationServiceAddition(
        {
          organizationId,
          serviceId: 'svc-authoring',
          domainId: 'dom-authoring',
          name: 'Authoring Service',
          outcome: 'Organizations are authored via the facade.',
          ownerRole: 'organization_owner',
          consumers: ['operator'],
          tier: 'confidential',
          tenantSlug,
        },
        now
      )
    ).toThrow(/domain add/);

    const domain = buildOrganizationDomainRecord(
      {
        organizationId,
        domainId: 'dom-authoring',
        name: 'Authoring Domain',
        ownerRole: 'organization_owner',
        tier: 'confidential',
        tenantSlug,
      },
      now
    );
    saveOrganizationDomain(domain);
    const addition = buildOrganizationServiceAddition(
      {
        organizationId,
        serviceId: 'svc-authoring',
        domainId: 'dom-authoring',
        name: 'Authoring Service',
        outcome: 'Organizations are authored via the facade.',
        ownerRole: 'organization_owner',
        consumers: ['operator'],
        tier: 'confidential',
        tenantSlug,
      },
      now
    );
    expect(addition.service.slis).toHaveLength(1);
    expect(addition.domain.service_ids).toEqual(['svc-authoring']);
    saveOrganizationService(addition.service);
    saveOrganizationDomain(addition.domain);

    const operation = buildOrganizationOperationRecord(
      {
        organizationId,
        operationId: 'op-authoring-review',
        name: 'Weekly authoring review',
        operationType: 'scheduled',
        ownerRole: 'organization_owner',
        tier: 'confidential',
        tenantSlug,
        serviceId: 'svc-authoring',
        triggerKind: 'schedule',
        triggerExpression: '0 9 * * 1',
      },
      now
    );
    expect(operation.trigger).toEqual({ kind: 'schedule', expression: '0 9 * * 1' });
    saveOrganizationOperation(operation);

    expect(() =>
      buildOrganizationProjectLink(
        { organizationId, projectId: 'prj-lc08-missing', tier: 'confidential', tenantSlug },
        now
      )
    ).toThrow(/project registry/);

    const projectPath = saveProjectRecord({
      project_id: 'prj-lc08-authoring-test',
      name: 'LC08 Authoring Test Project',
      summary: 'Temporary project registry record for the authoring test.',
      status: 'active',
      tier: 'confidential',
      tenant_slug: tenantSlug,
    });
    try {
      const attached = buildOrganizationProjectLink(
        { organizationId, projectId: 'prj-lc08-authoring-test', tier: 'confidential', tenantSlug },
        now
      );
      expect(attached.active_project_ids).toEqual(['prj-lc08-authoring-test']);
      saveOrganizationOperationalState(attached);
      expect(() =>
        buildOrganizationProjectLink(
          {
            organizationId,
            projectId: 'prj-lc08-authoring-test',
            tier: 'confidential',
            tenantSlug,
          },
          now
        )
      ).toThrow(/already attached/);
      const detached = buildOrganizationProjectLink(
        {
          organizationId,
          projectId: 'prj-lc08-authoring-test',
          tier: 'confidential',
          tenantSlug,
          detach: true,
        },
        now
      );
      expect(detached.active_project_ids).toEqual([]);
    } finally {
      safeRmSync(projectPath);
    }

    const view = buildOrganizationManagementView({
      organizationId,
      tier: 'confidential',
      tenantSlug,
    });
    expect(view.purpose?.objectives?.map((entry) => entry.objective_id)).toEqual([
      'obj-authoring-1',
    ]);
    expect(view.domains.map((entry) => entry.domain_id)).toEqual(['dom-authoring']);
    expect(view.services.map((entry) => entry.service_id)).toEqual(['svc-authoring']);
    expect(view.operations.map((entry) => entry.operation_id)).toEqual(['op-authoring-review']);
  });
});
