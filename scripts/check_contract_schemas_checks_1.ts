import {
  createNextActionContract,
  createOutcomeContract,
  resolveIntentResolutionContract,
} from '@agent/core';
import { readGovernanceJson, type ContractCheck } from './check_contract_schemas_shared.js';

export function createContractSchemaChecksPart1(): ContractCheck[] {
  return [
    {
      id: 'intent-resolution',
      schemaPath: 'knowledge/product/schemas/intent-resolution.schema.json',
      validPayloads: [resolveIntentResolutionContract('今週の進捗レポートを作って')],
      invalidPayloads: [
        {
          request_id: 'ir-invalid-1',
          normalized_intent: 'unresolved_intent',
          missing_inputs: [],
          resolution_shape: 'direct_answer',
          outcome_kind: 'answer',
          authority_level: 'autonomous',
          rationale: '',
        },
      ],
    },
    {
      id: 'intent-resolution-packet',
      schemaPath: 'knowledge/product/schemas/intent-resolution-packet.schema.json',
      validPayloads: [
        {
          kind: 'intent_resolution_packet',
          utterance: '今週の進捗レポートを docx で作って',
          selected_intent_id: 'generate-report',
          selected_confidence: 0.87,
          selected_resolution: {
            shape: 'direct_answer',
            task_kind: 'report_document',
            result_shape: 'document',
          },
          candidates: [
            {
              intent_id: 'generate-report',
              confidence: 0.87,
              source: 'catalog',
              matched_keywords: ['report'],
              reasons: ['matched keywords: report'],
              resolution: {
                shape: 'direct_answer',
                task_kind: 'report_document',
                result_shape: 'document',
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'intent_resolution_packet',
          utterance: '',
          candidates: [],
        },
      ],
    },
    {
      id: 'track-policy-override',
      schemaPath: 'knowledge/product/schemas/track-policy-override.schema.json',
      validPayloads: [
        {
          track_types: {
            delivery: {
              entry_criteria: ['tenant approval captured'],
              gate_profile: 'strict-sdlc',
            },
          },
          lifecycle_models: {
            'default-sdlc': {
              phases: ['custom_review'],
              gates_per_phase: {
                custom_review: ['gate-custom-review'],
              },
            },
          },
        },
      ],
      invalidPayloads: [
        {
          track_types: [],
        },
      ],
    },
    {
      id: 'next-action',
      schemaPath: 'knowledge/product/schemas/next-action.schema.json',
      validPayloads: [
        createNextActionContract({
          actionId: 'act-schema-1',
          type: 'approve',
          reason: 'Approval queue is blocked.',
          risk: 'medium',
          suggestedSurfaceAction: 'approvals',
          approvalRequired: false,
        }),
      ],
      invalidPayloads: [
        {
          action_id: 'act-schema-invalid-1',
          next_action_type: 'approve',
          reason: 'Missing operation hint',
          risk: 'low',
          approval_required: false,
        },
      ],
    },
    {
      id: 'memory-candidate',
      schemaPath: 'knowledge/product/schemas/memory-candidate.schema.json',
      validPayloads: [
        {
          candidate_id: 'mem-cand-1',
          source_type: 'mission',
          source_ref: 'MSN-100',
          proposed_memory_kind: 'heuristic',
          summary: 'When preflight fails, request clarification before retrying.',
          evidence_refs: ['knowledge/confidential/mission/MSN-100/evidence/log.md'],
          sensitivity_tier: 'confidential',
          ratification_required: true,
          status: 'queued',
          queued_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
      invalidPayloads: [
        {
          candidate_id: 'mem-cand-invalid-1',
          source_type: 'mission',
          source_ref: 'MSN-101',
          proposed_memory_kind: 'heuristic',
          summary: 'Missing evidence refs should fail.',
          evidence_refs: [],
          sensitivity_tier: 'confidential',
          ratification_required: false,
          status: 'queued',
          queued_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'outcome-contract',
      schemaPath: 'knowledge/product/schemas/outcome-contract.schema.json',
      validPayloads: [
        createOutcomeContract({
          outcomeId: 'outcome-schema-1',
          requestedResult: 'Generate the weekly report',
          deliverableKind: 'docx',
          successCriteria: ['report exists', 'report is reviewable'],
          evidenceRequired: true,
          expectedArtifacts: [{ kind: 'docx', storage_class: 'artifact_store' }],
          verificationMethod: 'review_gate',
        }),
      ],
      invalidPayloads: [
        {
          outcome_id: 'outcome-schema-invalid-1',
          requested_result: 'Missing criteria should fail',
          deliverable_kind: 'summary',
          success_criteria: [],
          evidence_required: false,
          expected_artifacts: [],
          verification_method: 'self_check',
        },
      ],
    },
    {
      id: 'artifact-record',
      schemaPath: 'knowledge/product/schemas/artifact-ownership-record.schema.json',
      validPayloads: [
        {
          artifact_id: 'ART-schema-1',
          project_id: 'PRJ-schema-1',
          kind: 'pptx',
          storage_class: 'artifact_store',
          path: 'active/shared/tmp/schema-example.pptx',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          evidence_refs: ['artifact:ART-1'],
        },
      ],
      invalidPayloads: [
        {
          artifact_id: 'ART-invalid-1',
          kind: 'pptx',
          storage_class: 'artifact_store',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          evidence_refs: ['artifact:ART-1'],
        },
      ],
    },
    {
      id: 'project-record',
      schemaPath: 'knowledge/product/schemas/project-record.schema.json',
      validPayloads: [
        {
          project_id: 'PRJ-schema-1',
          name: 'Schema Project',
          summary: 'Project schema validation fixture.',
          status: 'active',
          tier: 'confidential',
          tenant_slug: 'schema-tenant',
          primary_locale: 'ja-JP',
          service_bindings: ['BIND-schema-1'],
          default_track_id: 'TRK-schema-1',
          active_tracks: ['TRK-schema-1'],
          bootstrap_work_items: [
            {
              work_id: 'WRK-schema-1',
              kind: 'task_session',
              title: 'Frame the project',
              summary: 'Outline project scope.',
              status: 'active',
              specialist_id: 'project-lead',
            },
          ],
          proposed_mission_ids: ['MSN-schema-1'],
        },
      ],
      invalidPayloads: [
        {
          project_id: 'PRJ-invalid-1',
          name: 'Broken Project',
          status: 'active',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-operating-model',
      schemaPath: 'knowledge/product/schemas/organization-operating-model.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/orchestration/organization-operating-model.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          work_shapes: [],
          relationship_types: [],
          resolution_examples: [],
        },
      ],
    },
    {
      id: 'organization-catalog',
      schemaPath: 'knowledge/product/schemas/organization-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/orchestration/organization-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          organization_id: 'org-invalid-1',
          tier: 'confidential',
          domains: [{}],
          capabilities: [],
          services: [],
        },
      ],
    },
    {
      id: 'organization-domain',
      schemaPath: 'knowledge/product/schemas/organization-domain.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          domain_id: 'domain-schema-1',
          organization_id: 'org-schema-1',
          name: 'Schema Domain',
          owner_role: 'domain_owner',
          capability_ids: ['capability-schema-1'],
          service_ids: ['service-schema-1'],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          domain_id: 'domain-invalid-1',
          organization_id: 'org-schema-1',
          name: 'Broken Domain',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-capability',
      schemaPath: 'knowledge/product/schemas/organization-capability.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          capability_id: 'capability-schema-1',
          organization_id: 'org-schema-1',
          domain_id: 'domain-schema-1',
          name: 'Schema Capability',
          owner_role: 'capability_owner',
          service_ids: ['service-schema-1'],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          capability_id: 'capability-invalid-1',
          organization_id: 'org-schema-1',
          domain_id: 'domain-schema-1',
          name: 'Broken Capability',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-service',
      schemaPath: 'knowledge/product/schemas/organization-service.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          service_id: 'service-schema-1',
          organization_id: 'org-schema-1',
          domain_id: 'domain-schema-1',
          name: 'Schema Service',
          outcome: 'Service contract validation succeeds.',
          owner_role: 'service_owner',
          consumers: ['operators'],
          slo: {
            target: 'Within one business day',
            measurement_window: 'rolling_30_days',
            objective: 0.95,
            unit: 'fraction',
          },
          slis: [
            {
              sli_id: 'schema-sli-1',
              name: 'Response freshness',
              source_ref: 'service://schema/response',
              freshness_seconds: 3600,
            },
          ],
          runbook_refs: ['knowledge/product/orchestration/meeting-operations-playbook.md'],
          escalation_path: ['service_owner', 'incident_commander'],
          dependencies: [],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          service_id: 'service-invalid-1',
          organization_id: 'org-schema-1',
          domain_id: 'domain-schema-1',
          name: 'Broken Service',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-service-state',
      schemaPath: 'knowledge/product/schemas/organization-service-state.schema.json',
      validPayloads: [
        {
          service_id: 'service-schema-1',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          health: 'healthy',
          observed_at: '2026-08-03T00:00:00.000Z',
          source_timestamp: '2026-08-03T00:00:00.000Z',
          freshness_seconds: 60,
          confidence: 0.95,
          reconcile_status: 'current',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          service_id: 'service-invalid-1',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          health: 'healthy',
        },
      ],
    },
    {
      id: 'organization-operation',
      schemaPath: 'knowledge/product/schemas/organization-operation.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          operation_id: 'monthly-billing',
          organization_id: 'org-schema-1',
          service_id: 'service-schema-1',
          name: 'Monthly Billing',
          operation_type: 'scheduled',
          owner_role: 'finance_controller',
          trigger: { kind: 'schedule', expression: '0 9 1 * *', timezone: 'Asia/Tokyo' },
          automation_boundary: {
            allowed_actions: ['prepare_report'],
            approval_required_actions: ['submit_invoice'],
            forbidden_actions: ['change_payment_account'],
          },
          escalation_path: ['finance_controller', 'governance_owner'],
          evidence_outputs: ['billing-report'],
          execution_target: { kind: 'task_session', ref: 'runbook:monthly-billing' },
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          operation_id: 'operation-invalid-1',
          organization_id: 'org-schema-1',
          name: 'Broken Operation',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-operation-state',
      schemaPath: 'knowledge/product/schemas/organization-operation-state.schema.json',
      validPayloads: [
        {
          operation_id: 'monthly-billing',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'succeeded',
          due_status: 'current',
          last_run_at: '2026-08-01T00:00:00.000Z',
          next_due_at: '2026-09-01T00:00:00.000Z',
          last_evidence_refs: ['active/shared/tmp/billing-report.json'],
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          operation_id: 'operation-invalid-1',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          status: 'succeeded',
        },
      ],
    },
    {
      id: 'organization-operation-run',
      schemaPath: 'knowledge/product/schemas/organization-operation-run.schema.json',
      validPayloads: [
        {
          run_id: 'monthly-billing-20260801',
          operation_id: 'monthly-billing',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'succeeded',
          started_at: '2026-08-01T00:00:00.000Z',
          completed_at: '2026-08-01T00:30:00.000Z',
          execution_ref: 'task-session:monthly-billing-20260801',
          evidence_refs: ['active/shared/tmp/billing-report.json'],
          recorded_at: '2026-08-01T00:31:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          run_id: 'run-invalid-1',
          operation_id: 'operation-invalid-1',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          status: 'succeeded',
        },
      ],
    },
    {
      id: 'organization-work-resolution',
      schemaPath: 'knowledge/product/schemas/organization-work-resolution.schema.json',
      validPayloads: [
        {
          kind: 'organization_work_resolution',
          utterance: 'Prepare this month operation report',
          organization_id: 'org-schema-1',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          work_shape: 'routine_operation',
          management_unit: 'operation',
          proposed_parent: { kind: 'operation', reason: 'scheduled work' },
          confidence: 0.88,
          authority_class: 'normal',
          human_decision: 'pending',
          reasons: ['Recurring operation.'],
          next_questions: ['Specify operation_id?'],
          dry_run: true,
        },
      ],
      invalidPayloads: [
        {
          kind: 'organization_work_resolution',
          utterance: 'broken',
          organization_id: 'org-schema-1',
          work_shape: 'unknown',
          management_unit: 'operation',
          confidence: 2,
          authority_class: 'normal',
          human_decision: 'pending',
          reasons: [],
          next_questions: [],
          dry_run: false,
        },
      ],
    },
    {
      id: 'organization-incident',
      schemaPath: 'knowledge/product/schemas/organization-incident.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          incident_id: 'incident-schema-1',
          organization_id: 'org-schema-1',
          service_id: 'service-schema-1',
          title: 'Schema incident',
          severity: 'high',
          status: 'triaging',
          owner_role: 'incident_commander',
          impact_summary: 'Validation incident.',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          created_at: '2026-08-03T00:00:00.000Z',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [{ incident_id: 'incident-invalid-1', severity: 'unknown' }],
    },
    {
      id: 'organization-cadence',
      schemaPath: 'knowledge/product/schemas/organization-cadence.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          cadence_id: 'cadence-schema-1',
          organization_id: 'org-schema-1',
          name: 'Monthly operating review',
          cadence_type: 'monthly',
          schedule: '0 10 1 * *',
          owner_role: 'organization_owner',
          decision_ids: ['decision-schema-1'],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [{ cadence_id: 'cadence-invalid-1', organization_id: 'org-schema-1' }],
    },
    {
      id: 'organization-decision',
      schemaPath: 'knowledge/product/schemas/organization-decision.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          decision_id: 'decision-schema-1',
          organization_id: 'org-schema-1',
          cadence_id: 'cadence-schema-1',
          title: 'Approve SLO change',
          decision_type: 'slo_change',
          status: 'pending_approval',
          decision_owner: 'organization_owner',
          due_at: '2026-08-10T00:00:00.000Z',
          options: ['approve', 'defer'],
          follow_up_refs: [],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [{ decision_id: 'decision-invalid-1', status: 'pending_approval' }],
    },
    {
      id: 'organization-learning-candidate',
      schemaPath: 'knowledge/product/schemas/organization-learning-candidate.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          learning_id: 'learning-schema-1',
          organization_id: 'org-schema-1',
          source_type: 'incident_review',
          source_ref: 'incident-schema-1',
          title: 'Incident review candidate',
          summary: 'Promote the corrected escalation sequence.',
          evidence_refs: ['active/shared/runtime/evidence/incident-schema-1.json'],
          target_kind: 'sop_candidate',
          status: 'proposed',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          created_at: '2026-08-03T00:00:00.000Z',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          learning_id: 'learning-invalid-1',
          organization_id: 'org-schema-1',
          source_type: 'unknown',
          status: 'promoted',
        },
      ],
    },
    {
      id: 'organization-purpose',
      schemaPath: 'knowledge/product/schemas/organization-purpose.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          organization_id: 'org-schema-1',
          name: 'Schema Organization',
          purpose: 'Validate organization purpose contracts.',
          principles: ['Evidence before action.'],
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          owner_role: 'organization_owner',
          approval_state: 'approved',
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          organization_id: 'org-invalid-1',
          name: 'Broken Organization',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'organization-operational-state',
      schemaPath: 'knowledge/product/schemas/organization-operational-state.schema.json',
      validPayloads: [
        {
          organization_id: 'org-schema-1',
          name: 'Schema Organization',
          tier: 'confidential',
          tenant_slug: 'tenant-acme',
          status: 'active',
          active_project_ids: ['PRJ-schema-1'],
          service_health_summary: { healthy: 1, degraded: 0, critical: 0, unknown: 0 },
          updated_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          organization_id: 'org-invalid-1',
          name: 'Broken Organization',
          tier: 'confidential',
        },
      ],
    },
    {
      id: 'service-binding-record',
      schemaPath: 'knowledge/product/schemas/service-binding-record.schema.json',
      validPayloads: [
        {
          binding_id: 'BIND-schema-1',
          service_type: 'github',
          scope: 'repository',
          target: 'org/repo',
          allowed_actions: ['read', 'pull_request'],
          secret_refs: ['vault://bindings/github/schema/token'],
          approval_policy: {
            pull_request: 'allowed',
            merge: 'approval_required',
          },
          service_id: 'github',
          auth_mode: 'secret-guard',
        },
      ],
      invalidPayloads: [
        {
          binding_id: 'BIND-invalid-1',
          service_type: 'github',
          scope: 'repository',
          target: 'org/repo',
          allowed_actions: ['read'],
          secret_refs: [],
          approval_policy: {
            pull_request: 'invalid',
          },
        },
      ],
    },
    {
      id: 'mission-queue-entry',
      schemaPath: 'knowledge/product/schemas/mission-queue.schema.json',
      validPayloads: [
        {
          mission_id: 'MSN-SCHEMA-1',
          tier: 'confidential',
          priority: 5,
          status: 'pending',
          enqueued_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          dependencies: ['MSN-SCHEMA-DEP-1'],
        },
      ],
      invalidPayloads: [
        {
          mission_id: 'MSN-SCHEMA-2',
          tier: 'confidential',
          priority: 5,
          status: 'queued',
          enqueued_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          dependencies: [],
        },
      ],
    },
    {
      id: 'mission-orchestration-event',
      schemaPath: 'knowledge/product/schemas/mission-orchestration-event.schema.json',
      validPayloads: [
        {
          event_id: 'ME-schema-1',
          event_type: 'mission_issue_requested',
          mission_id: 'MSN-SCHEMA-1',
          requested_by: 'test',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          payload: {
            channel: 'slack',
            threadTs: '123',
          },
        },
      ],
      invalidPayloads: [
        {
          event_id: 'ME-schema-2',
          event_type: 'mission_issue_requested',
          mission_id: 'MSN-SCHEMA-1',
          requested_by: 'test',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'approval-action',
      schemaPath: 'knowledge/product/schemas/approval-action.schema.json',
      validPayloads: [
        {
          action: 'create',
          params: {
            channel: 'terminal',
            storageChannel: 'terminal',
            threadTs: '1714060800.000100',
            correlationId: 'corr-schema-1',
            requestedBy: 'agent-1',
            draft: {
              title: 'Rotate secret',
              summary: 'Rotate the GitHub token.',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'secret-action',
      schemaPath: 'knowledge/product/schemas/secret-action.schema.json',
      validPayloads: [
        {
          action: 'set',
          params: {
            account: 'test_user',
            service: 'slack',
            value: 'secret123',
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {
            account: 'test_user',
            service: 'slack',
          },
        },
      ],
    },
    {
      id: 'artifact-action',
      schemaPath: 'knowledge/product/schemas/artifact-action.schema.json',
      validPayloads: [
        {
          action: 'write_delivery_pack',
          params: {
            role: 'mission_controller',
            logicalDir: 'active/shared/delivery-packs',
            packId: 'PACK-schema-1',
            summary: 'Schema check delivery pack',
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'agent-action',
      schemaPath: 'knowledge/product/schemas/agent-action.schema.json',
      validPayloads: [
        {
          action: 'spawn',
          params: {
            agentId: 'agent-schema-1',
            missionId: 'MSN-schema-1',
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'service-action',
      schemaPath: 'knowledge/product/schemas/service-action.schema.json',
      validPayloads: [
        {
          service_id: 'github',
          mode: 'API',
          action: 'create_issue',
          method: 'POST',
          params: {
            owner: 'famaoai',
            repo: 'kyberion',
          },
          auth: 'secret-guard',
        },
        {
          action: 'pipeline',
          context: {
            request_id: 'REQ-schema-1',
          },
          steps: [
            {
              op: 'api',
              params: {
                service_id: 'github',
                action: 'create_issue',
                params: {
                  owner: 'famaoai',
                  repo: 'kyberion',
                },
                auth: 'secret-guard',
                method: 'POST',
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          service_id: 'github',
          mode: 'INVALID',
          action: 'create_issue',
          params: {},
        },
      ],
    },
    {
      id: 'blockchain-action',
      schemaPath: 'knowledge/product/schemas/blockchain-action.schema.json',
      validPayloads: [
        {
          action: 'anchor_mission',
          params: {
            mission_id: 'MSN-schema-1',
            hash: 'sha256:abc123',
          },
        },
        {
          action: 'anchor_trust',
          params: {
            agent_id: 'agent-schema-1',
            score: 87,
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
    {
      id: 'presence-action',
      schemaPath: 'knowledge/product/schemas/presence-action.schema.json',
      validPayloads: [
        {
          action: 'dispatch',
          params: {
            channel: 'general',
            payload: {
              text: 'hello world',
            },
          },
        },
        {
          action: 'receive_event',
          params: {
            channel: 'general',
            payload: {
              event_type: 'click',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'unsupported',
          params: {},
        },
      ],
    },
  ];
}
