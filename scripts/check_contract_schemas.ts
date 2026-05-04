import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  buildPromotedMemoryRecord,
  createDistillCandidateRecord,
  resolveIntentResolutionContract,
  createNextActionContract,
  createOutcomeContract,
  createTaskSession,
  pathResolver,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readGovernanceJson(relativePath: string): unknown {
  return readJsonFile(pathResolver.rootResolve(relativePath));
}

type ContractCheck = {
  id: string;
  schemaPath: string;
  validPayloads: unknown[];
  invalidPayloads: unknown[];
};

function createChecks(): ContractCheck[] {
  const workPolicy = readJsonFile(pathResolver.rootResolve('knowledge/public/governance/work-policy.json'));
  const surfaceProviderManifests = readJsonFile(
    pathResolver.rootResolve('knowledge/public/governance/surface-provider-manifests.json')
  );
  const surfacePolicy = readJsonFile(pathResolver.rootResolve('knowledge/public/governance/surface-policy.json'));

  const promotedPattern = buildPromotedMemoryRecord(
    createDistillCandidateRecord({
      source_type: 'task_session',
      title: 'Reusable presentation pattern',
      summary: 'Presentation pattern should be reusable.',
      status: 'promoted',
      target_kind: 'pattern',
      artifact_ids: ['ART-1'],
      evidence_refs: ['artifact:ART-1'],
      metadata: {
        applicability: ['presentation delivery'],
        reusable_steps: ['Review the deck', 'Adapt the structure'],
        expected_outcome: 'A reusable presentation artifact.',
      },
    })
  );
  const promotedSop = buildPromotedMemoryRecord(
    createDistillCandidateRecord({
      source_type: 'task_session',
      title: 'Reusable SOP candidate',
      summary: 'Operational handling should be reusable.',
      status: 'promoted',
      target_kind: 'sop_candidate',
      metadata: {
        procedure_steps: ['Check the queue', 'Execute the approval flow'],
        safety_notes: ['Do not skip ratification'],
        escalation_conditions: ['Evidence missing'],
      },
    })
  );
  const promotedHint = buildPromotedMemoryRecord(
    createDistillCandidateRecord({
      source_type: 'artifact',
      title: 'Browser hint',
      summary: 'Use the browser operator for repeatable site navigation.',
      status: 'promoted',
      target_kind: 'knowledge_hint',
      metadata: {
        hint_scope: 'browser navigation',
        hint_triggers: ['open site', 'go to page'],
        recommended_refs: ['knowledge/public/procedures/browser/navigate-web.md'],
      },
    })
  );
  const promotedTemplate = buildPromotedMemoryRecord(
    createDistillCandidateRecord({
      source_type: 'mission',
      title: 'Report template',
      summary: 'Reusable report structure.',
      status: 'promoted',
      target_kind: 'report_template',
      metadata: {
        template_sections: ['Summary', 'Findings', 'Next Steps'],
        audience: 'operators',
        output_format: 'markdown',
      },
    })
  );

  const additionalGovernanceChecks: ContractCheck[] = [
    {
      id: 'intent-policy',
      schemaPath: 'knowledge/public/schemas/intent-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/intent-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          delivery: { rules: [] },
        },
      ],
    },
    {
      id: 'active-surfaces',
      schemaPath: 'knowledge/public/schemas/runtime-surface-manifest.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/active-surfaces.json')],
      invalidPayloads: [
        {
          version: 1,
        },
      ],
    },
    {
      id: 'model-registry',
      schemaPath: 'knowledge/public/schemas/model-registry.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/model-registry.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          default_model_id: 'openai:gpt-5.4',
        },
      ],
    },
    {
      id: 'model-adaptation-policy',
      schemaPath: 'knowledge/public/schemas/model-adaptation-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/model-adaptation-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'harness-capability-registry',
      schemaPath: 'knowledge/public/schemas/harness-capability-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/harness-capability-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'harness-adapter-registry',
      schemaPath: 'knowledge/public/schemas/harness-adapter-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/harness-adapter-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'provider-capability-scan-policy',
      schemaPath: 'knowledge/public/schemas/provider-capability-scan-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/provider-capability-scan-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          providers: [],
        },
      ],
    },
    {
      id: 'capability-lifecycle-procedure',
      schemaPath: 'knowledge/public/schemas/capability-lifecycle-procedure.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/capability-lifecycle-procedure.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          procedure_id: 'other',
        },
      ],
    },
    {
      id: 'capability-bundle-registry',
      schemaPath: 'knowledge/public/schemas/capability-bundle-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/capability-bundle-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          bundles: [],
        },
      ],
    },
    {
      id: 'execution-receipt-policy',
      schemaPath: 'knowledge/public/schemas/execution-receipt-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/execution-receipt-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-profile-registry',
      schemaPath: 'knowledge/public/schemas/voice-profile-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/voice-profile-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-runtime-policy',
      schemaPath: 'knowledge/public/schemas/voice-runtime-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/voice-runtime-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-engine-registry',
      schemaPath: 'knowledge/public/schemas/voice-engine-registry.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/voice-engine-registry.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-sample-ingestion-policy',
      schemaPath: 'knowledge/public/schemas/voice-sample-ingestion-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/voice-sample-ingestion-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'video-composition-template-registry',
      schemaPath: 'knowledge/public/schemas/video-composition-template-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/video-composition-template-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'video-render-runtime-policy',
      schemaPath: 'knowledge/public/schemas/video-render-runtime-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/video-render-runtime-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-classification-policy',
      schemaPath: 'knowledge/public/schemas/mission-classification-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/mission-classification-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'authority-role-index',
      schemaPath: 'knowledge/public/schemas/authority-role-index.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/authority-role-index.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'team-role-index',
      schemaPath: 'knowledge/public/schemas/team-role-index.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/orchestration/team-role-index.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'agent-profile-index',
      schemaPath: 'knowledge/public/schemas/agent-profile-index.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/orchestration/agent-profile-index.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-workflow-catalog',
      schemaPath: 'knowledge/public/schemas/mission-workflow-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/mission-workflow-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-review-gate-registry',
      schemaPath: 'knowledge/public/schemas/mission-review-gate-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/mission-review-gate-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'path-scope-policy',
      schemaPath: 'knowledge/public/schemas/path-scope-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/public/governance/path-scope-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-orchestration-scenario-pack',
      schemaPath: 'knowledge/public/schemas/mission-orchestration-scenario-pack.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/mission-orchestration-scenario-pack.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
  ];

  return [
    {
      id: 'intent-resolution',
      schemaPath: 'schemas/intent-resolution.schema.json',
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
      schemaPath: 'knowledge/public/schemas/intent-resolution-packet.schema.json',
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
      id: 'next-action',
      schemaPath: 'schemas/next-action.schema.json',
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
      schemaPath: 'schemas/memory-candidate.schema.json',
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
      schemaPath: 'schemas/outcome-contract.schema.json',
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
      schemaPath: 'schemas/artifact-record.schema.json',
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
      schemaPath: 'knowledge/public/schemas/project-record.schema.json',
      validPayloads: [
        {
          project_id: 'PRJ-schema-1',
          name: 'Schema Project',
          summary: 'Project schema validation fixture.',
          status: 'active',
          tier: 'confidential',
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
      id: 'service-binding-record',
      schemaPath: 'knowledge/public/schemas/service-binding-record.schema.json',
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
      schemaPath: 'schemas/mission-queue.schema.json',
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
      schemaPath: 'knowledge/public/schemas/mission-orchestration-event.schema.json',
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
      schemaPath: 'schemas/approval-action.schema.json',
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
      schemaPath: 'schemas/secret-action.schema.json',
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
      schemaPath: 'schemas/artifact-action.schema.json',
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
      schemaPath: 'schemas/agent-action.schema.json',
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
      schemaPath: 'schemas/service-action.schema.json',
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
      schemaPath: 'schemas/blockchain-action.schema.json',
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
      schemaPath: 'schemas/presence-action.schema.json',
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
    {
      id: 'process-action',
      schemaPath: 'schemas/process-action.schema.json',
      validPayloads: [
        {
          action: 'spawn',
          params: {
            resourceId: 'proc-schema-1',
            ownerId: 'mission-controller',
            ownerType: 'mission',
            kind: 'worker',
            command: 'node',
            args: ['--version'],
          },
        },
        {
          action: 'status',
          params: {
            resourceId: 'proc-schema-1',
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
      id: 'terminal-action',
      schemaPath: 'schemas/terminal-action.schema.json',
      validPayloads: [
        {
          action: 'spawn',
          params: {
            shell: '/bin/zsh',
          },
        },
        {
          action: 'resize',
          params: {
            sessionId: 'pty-1',
            cols: 120,
            rows: 40,
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
      id: 'vision-action',
      schemaPath: 'schemas/vision-action.schema.json',
      validPayloads: [
        {
          action: 'inspect_image',
          params: {
            path: 'active/shared/tmp/example.png',
          },
        },
        {
          action: 'pipeline',
          steps: [
            {
              action: 'ocr_image',
              params: {
                path: 'active/shared/tmp/example.png',
                language: 'eng',
              },
            },
          ],
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
      id: 'wisdom-action',
      schemaPath: 'schemas/wisdom-action.schema.json',
      validPayloads: [
        {
          action: 'knowledge_search',
          params: {
            query: 'voice generation',
          },
        },
        {
          action: 'knowledge_import',
          params: {
            source_path: 'knowledge/public/tmp/import.json',
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
      id: 'voice-action',
      schemaPath: 'schemas/voice-action.schema.json',
      validPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-1',
          text: 'hello world',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 200,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
        {
          action: 'register_voice_profile',
          request_id: 'reg-schema-1',
          profile: {
            profile_id: 'user-ja-voice',
            display_name: 'User JA',
            tier: 'personal',
            languages: ['ja'],
            default_engine_id: 'open_voice_clone',
          },
          samples: [
            { sample_id: 's1', path: 'Downloads/sample-1.wav', language: 'ja' },
            { sample_id: 's2', path: 'Downloads/sample-2.wav', language: 'ja' },
          ],
        },
        {
          action: 'pipeline',
          steps: [
            {
              action: 'generate_voice',
              request_id: 'req-schema-1',
              text: 'hello world',
              profile_ref: {
                profile_id: 'operator-ja-default',
              },
              engine: {
                engine_id: 'local_say',
              },
              rendering: {
                language: 'ja',
                chunking: {
                  max_chunk_chars: 200,
                  crossfade_ms: 50,
                  preserve_paralinguistic_tags: true,
                },
              },
              delivery: {
                mode: 'artifact',
                format: 'wav',
                emit_progress_packets: true,
              },
            },
          ],
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
      id: 'voice-generation-adf',
      schemaPath: 'knowledge/public/schemas/voice-generation-adf.schema.json',
      validPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-1',
          text: 'hello world',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 200,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
      ],
      invalidPayloads: [
        {
          action: 'generate_voice',
          request_id: 'req-schema-invalid-1',
          text: '',
          profile_ref: {
            profile_id: 'operator-ja-default',
          },
          engine: {
            engine_id: 'local_say',
          },
          rendering: {
            language: 'ja',
            chunking: {
              max_chunk_chars: 50,
              crossfade_ms: 50,
              preserve_paralinguistic_tags: true,
            },
          },
          delivery: {
            mode: 'artifact',
            format: 'wav',
            emit_progress_packets: true,
          },
        },
      ],
    },
    {
      id: 'music-generation-adf',
      schemaPath: 'knowledge/public/schemas/music-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'music-generation-adf',
          version: '1.0.0',
          intent: 'anniversary_song',
          style: {
            genre: 'country',
            mood: ['warm', 'hopeful'],
            vocal: {
              presence: true,
              gender: 'female',
              language: 'ja',
            },
          },
          composition: {
            duration_sec: 180,
            bpm: 84,
            key: 'D major',
            structure: ['verse', 'chorus'],
          },
          lyrics: {
            mode: 'provided',
            text: '[Verse]\nありがとう',
          },
          arrangement: {
            instruments: ['acoustic_guitar', 'harmonica'],
            mix_traits: ['intimate'],
          },
          output: {
            format: 'mp3',
            filename_prefix: 'anniversary-song',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'music-generation-adf',
          version: '1.0.0',
          style: {
            genre: 'country',
            vocal: {
              presence: true,
            },
          },
          lyrics: {
            mode: 'provided',
          },
          output: {
            format: 'mp3',
          },
        },
      ],
    },
    {
      id: 'media-generation-action',
      schemaPath: 'schemas/media-generation-action.schema.json',
      validPayloads: [
        {
          action: 'generate_image',
          params: {
            workflow_path: 'active/shared/tmp/image-workflow.json',
          },
        },
        {
          action: 'submit_generation',
          params: {
            action: 'generate_music',
            params: {
              music_adf: {
                kind: 'music-generation-adf',
                version: '1.0.0',
              },
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
      id: 'image-generation-adf',
      schemaPath: 'knowledge/public/schemas/image-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'image-generation-adf',
          version: '1.0.0',
          intent: 'country_cover',
          prompt: 'country road at golden hour',
          negative_prompt: 'blurry',
          canvas: { width: 1024, height: 1024 },
          output: { format: 'png', filename_prefix: 'country-cover' },
        },
      ],
      invalidPayloads: [
        {
          kind: 'image-generation-adf',
          version: '1.0.0',
          prompt: 'country road at golden hour',
          canvas: { width: 32, height: 32 },
          output: { format: 'png' },
        },
      ],
    },
    {
      id: 'video-generation-adf',
      schemaPath: 'knowledge/public/schemas/video-generation-adf.schema.json',
      validPayloads: [
        {
          kind: 'video-generation-adf',
          version: '1.0.0',
          prompt: 'cinematic driving shot',
          composition: { duration_sec: 5, fps: 24 },
          engine: {
            provider: 'comfyui',
            workflow_template: 'embedded',
            base_workflow: {
              '1': {
                class_type: 'TextNode',
                inputs: { text: '{{prompt}}', fps: '{{fps}}', duration: '{{duration_sec}}' },
              },
            },
          },
          output: { format: 'mp4', filename_prefix: 'drive-shot' },
        },
      ],
      invalidPayloads: [
        {
          kind: 'video-generation-adf',
          version: '1.0.0',
          prompt: 'cinematic driving shot',
          composition: { duration_sec: 0 },
          engine: {
            provider: 'comfyui',
            workflow_template: 'embedded',
          },
          output: { format: 'mp4' },
        },
      ],
    },
    {
      id: 'computer-action',
      schemaPath: 'schemas/computer-action.schema.json',
      validPayloads: [
        {
          actions: [
            {
              type: 'click',
              x: 100,
              y: 200,
              button: 'left',
              target: 'browser',
            },
            {
              type: 'voice_output',
              text: 'hello',
              target: 'os',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          actions: [
            {
              type: 'unsupported',
            },
          ],
        },
      ],
    },
    {
      id: 'a2a-envelope',
      schemaPath: 'schemas/a2a-envelope.schema.json',
      validPayloads: [
        {
          a2a_version: '1.0',
          header: {
            msg_id: 'MSG-schema-1',
            sender: 'sender-x',
            receiver: 'agent-y',
            performative: 'request',
          },
          payload: {
            text: 'hello',
          },
        },
      ],
      invalidPayloads: [
        {
          a2a_version: '2.0',
          header: {
            msg_id: 'MSG-schema-1',
            sender: 'sender-x',
            performative: 'request',
          },
          payload: {},
        },
      ],
    },
    {
      id: 'bridge-request',
      schemaPath: 'schemas/bridge-request.schema.json',
      validPayloads: [
        {
          intent: 'request_marketing_material',
          context: {
            channel: 'slack',
          },
          params: {
            language: 'ja',
          },
        },
      ],
      invalidPayloads: [
        {
          context: {},
        },
      ],
    },
    {
      id: 'mission-contract',
      schemaPath: 'schemas/mission-contract.schema.json',
      validPayloads: [
        {
          mission_id: 'msn-schema-1',
          tier: 'confidential',
          skill: 'design',
          action: 'extract_design_spec',
          role: 'mission_controller',
          static_params: {
            project_name: 'Schema Project',
          },
          safety_gate: {
            risk_level: 3,
            require_sudo: false,
            approved_by_sovereign: true,
          },
        },
      ],
      invalidPayloads: [
        {
          mission_id: 'Invalid Space',
          tier: 'confidential',
          skill: 'design',
        },
      ],
    },
    {
      id: 'design-spec',
      schemaPath: 'schemas/design-spec.schema.json',
      validPayloads: [
        {
          version: 'v1',
          project_name: 'Schema Project',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          components: [
            {
              id: 'COMP-SCHEMA',
              name: 'Core Service',
              responsibility: 'Handles business logic',
              requirements_refs: ['FR-1'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          components: [],
        },
      ],
    },
    {
      id: 'task-plan',
      schemaPath: 'schemas/task-plan.schema.json',
      validPayloads: [
        {
          version: 'v1',
          project_name: 'Schema Project',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          tasks: [
            {
              task_id: 'T-IMPL-1',
              title: 'Implement core',
              summary: 'core module',
              priority: 'must',
              estimate: 'M',
              test_criteria: ['core tests pass'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          tasks: [],
        },
      ],
    },
    {
      id: 'generation-schedule',
      schemaPath: 'knowledge/public/schemas/generation-schedule.schema.json',
      validPayloads: [
        {
          kind: 'generation-schedule',
          schedule_id: 'monthly',
          enabled: true,
          trigger: { type: 'cron', cron: '0 7 1 * *', timezone: 'Asia/Tokyo' },
          job_template: { action: 'generate_music', params: {} },
          execution_policy: { concurrency: 'skip_if_running' },
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'generation-schedule',
          schedule_id: 'monthly',
          enabled: true,
          trigger: { type: 'cron' },
          execution_policy: { concurrency: 'skip_if_running' },
          created_at: '2026-03-01T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'generation-job',
      schemaPath: 'knowledge/public/schemas/generation-job.schema.json',
      validPayloads: [
        {
          kind: 'generation-job',
          job_id: 'genjob-schema-1',
          action: 'generate_music',
          status: 'submitted',
          request: {
            target_path: 'active/shared/exports/anniversary-song.mp3',
          },
          created_at: '2026-03-22T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'generation-job',
          job_id: 'genjob-schema-1',
          action: 'generate_music',
          status: 'submitted',
          request: {},
        },
      ],
    },
    {
      id: 'test-case-adf',
      schemaPath: 'knowledge/public/schemas/test-case-adf.schema.json',
      validPayloads: [
        {
          kind: 'test-case-adf',
          app_id: 'sample-app',
          cases: [
            {
              case_id: 'TC-1',
              title: 'Happy path',
              objective: 'Verify FR-1',
              steps: ['do x'],
              expected: ['outcome y'],
              automation_backend: 'browser',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'test-case-adf',
          app_id: '',
          cases: [],
        },
      ],
    },
    {
      id: 'document-brief',
      schemaPath: 'knowledge/public/schemas/document-brief.schema.json',
      validPayloads: [
        {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          document_profile: 'summary-report',
          render_target: 'docx',
          locale: 'en-US',
          payload: {
            title: 'Quarterly Reliability Review',
            summary: 'Reliability and incident posture improved across the quarter.',
            sections: [
              {
                heading: 'Incident Themes',
                body: ['Three recurring failure modes were reduced after remediation.'],
                bullets: ['Gateway timeout handling improved', 'Retry policy standardized'],
              },
            ],
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          render_target: 'docx',
          payload: {},
        },
      ],
    },
    {
      id: 'proposal-brief',
      schemaPath: 'knowledge/public/schemas/proposal-brief.schema.json',
      validPayloads: [
        {
          kind: 'proposal-brief',
          title: 'Kyberion Platform Proposal',
          client: 'Aster Bank',
          objective: 'Deliver a governed proposal deck',
          document_profile: 'executive-proposal',
          layout_template_id: 'executive-neutral',
          render_target: 'pptx',
          locale: 'en-US',
          audience: ['executive', 'ops'],
          story: {
            core_message: 'Kyberion makes governed execution visible and repeatable.',
            chapters: ['Context', 'Value', 'Delivery'],
            tone: 'confident',
            closing_cta: 'Approve the rollout',
          },
          evidence: [
            { title: 'Governed outputs', point: 'Artifacts are traceable and reproducible.' },
          ],
          required_sections: ['Summary', 'Evidence'],
        },
      ],
      invalidPayloads: [
        {
          kind: 'proposal-brief',
          title: 'Kyberion Platform Proposal',
          client: 'Aster Bank',
          objective: 'Deliver a governed proposal deck',
          audience: ['executive', 'ops'],
        },
      ],
    },
    {
      id: 'proposal-storyline-adf',
      schemaPath: 'knowledge/public/schemas/proposal-storyline-adf.schema.json',
      validPayloads: [
        {
          kind: 'proposal-storyline-adf',
          title: 'Digital Onboarding Transformation Proposal',
          client: 'Aster Bank',
          core_message: 'A lighter, guided onboarding experience reduces drop-off.',
          slides: [
            {
              id: 'why-change',
              title: 'Why change now',
              objective: 'Explain the business case',
              body: ['Current onboarding creates avoidable abandonment.'],
            },
            {
              id: 'decision',
              title: 'Decision',
              objective: 'Invite approval',
              visual: 'decision-cta',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'proposal-storyline-adf',
          client: 'Aster Bank',
          slides: [],
        },
      ],
    },
    {
      id: 'webview-session-handoff',
      schemaPath: 'knowledge/public/schemas/webview-session-handoff.schema.json',
      validPayloads: [
        {
          kind: 'webview-session-handoff',
          target_url: 'http://127.0.0.1:4173/app/home',
          origin: 'app://com.example.mobile',
          browser_session_id: 'session-1',
          prefer_persistent_context: true,
          source: {
            platform: 'android',
            app_id: 'example-mobile-login-passkey',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'webview-session-handoff',
          target_url: '',
          source: {
            platform: 'desktop',
          },
        },
      ],
    },
    {
      id: 'mobile-app-profile',
      schemaPath: 'knowledge/public/schemas/mobile-app-profile.schema.json',
      validPayloads: [
        {
          app_id: 'example-mobile-login-passkey',
          platform: 'android',
          title: 'Example Mobile Login + Passkey',
          package_name: 'com.example.mobile',
          launch: {
            component: 'com.example.mobile/.MainActivity',
          },
          selectors: {
            login: {
              email: {
                resource_id: 'email',
                class_name: 'EditText',
              },
              password: {
                resource_id: 'password',
                class_name: 'EditText',
              },
              submit: {
                text: 'sign in',
                resource_id: 'sign_in',
                class_name: 'Button',
              },
            },
            passkey: {
              trigger: {
                text: 'passkey',
                resource_id: 'passkey',
                class_name: 'Button',
              },
            },
          },
          webview: {
            entry_url: 'https://example.mobile.app/webview/login',
            allowed_origins: ['https://example.mobile.app'],
            session_handoff: {
              target_url: 'https://example.mobile.app/webview/login',
              browser_session_id: 'android-webview-example',
              prefer_persistent_context: true,
            },
            runtime_export: {
              format: 'json',
              android_device_path: '/sdcard/kyberion/example-mobile-webview-session.json',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          app_id: '',
          platform: 'android',
          package_name: '',
          selectors: {
            login: {
              email: {},
            },
          },
        },
      ],
    },
    {
      id: 'web-app-profile',
      schemaPath: 'knowledge/public/schemas/web-app-profile.schema.json',
      validPayloads: [
        {
          app_id: 'example-web-login-guarded',
          title: 'Example Web Login + Guarded Routes',
          base_url: 'http://127.0.0.1:4173',
          execution_preset: 'standard-web-auth',
          login_route: '/login',
          logout_route: '/logout',
          guarded_routes: ['/app/home', '/app/settings'],
          selectors: {
            login: {
              email: "[data-testid='email']",
              password: "[data-testid='password']",
              submit: "[data-testid='sign-in']",
            },
            navigation: {
              home: "[data-testid='nav-home']",
              settings: "[data-testid='nav-settings']",
              logout: "[data-testid='nav-logout']",
            },
          },
          session_handoff: {
            kind: 'webview-session-handoff',
            target_url: 'http://127.0.0.1:4173/app/home',
            origin: 'http://127.0.0.1:4173',
            browser_session_id: 'example-web-login-guarded',
            prefer_persistent_context: true,
          },
          debug_routes: {
            session_export: '/__kyberion/session-export',
          },
        },
      ],
      invalidPayloads: [
        {
          app_id: '',
          title: '',
          base_url: '',
          guarded_routes: ['/app/home', 1],
          debug_routes: {
            session_export: '',
          },
        },
      ],
    },
    {
      id: 'ui-flow-adf',
      schemaPath: 'knowledge/public/schemas/ui-flow-adf.schema.json',
      validPayloads: [
        {
          kind: 'ui-flow-adf',
          app_id: 'sample-web-app',
          platform: 'browser',
          entry_state: 'login',
          states: [
            {
              id: 'login',
              kind: 'route',
              path: '/login',
              selectors: {
                email: '[name=email]',
                password: '[name=password]',
                submit: 'button[type=submit]',
              },
            },
            {
              id: 'dashboard',
              kind: 'route',
              path: '/dashboard',
              guard: 'authenticated',
            },
            {
              id: 'session_export',
              kind: 'debug',
              path: '/__kyberion/session-export',
              guard: 'debug_only',
            },
          ],
          transitions: [
            {
              id: 'login_success',
              from: 'login',
              to: 'dashboard',
              action: 'submit_login',
              expected: 'authenticated route is reachable',
            },
            {
              id: 'session_export_transition',
              from: 'dashboard',
              to: 'session_export',
              action: 'open_debug_session_export',
              guard: 'debug_only',
              expected: 'session handoff artifact is returned',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'ui-flow-adf',
          app_id: 'sample-web-app',
          platform: 'desktop',
          states: [
            {
              id: 'login',
              kind: 'route',
              path: '/login',
            },
          ],
          transitions: [],
        },
      ],
    },
    {
      id: 'mission-seed-record',
      schemaPath: 'knowledge/public/schemas/mission-seed-record.schema.json',
      validPayloads: [
        {
          seed_id: 'MSD-schema-1',
          project_id: 'PRJ-schema-1',
          title: 'Design architecture',
          summary: 'Design the first architecture slice.',
          status: 'ready',
          specialist_id: 'document-specialist',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
      invalidPayloads: [
        {
          seed_id: 'MSD-invalid-1',
          title: 'Missing project id',
          summary: 'This should fail',
          status: 'ready',
          specialist_id: 'document-specialist',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'booking-preference-profile',
      schemaPath: 'knowledge/public/schemas/booking-preference-profile.schema.json',
      validPayloads: [
        {
          kind: 'booking-preference-profile',
          profile_id: 'travel-points-routing-example',
          scope: 'personal_travel',
          security_boundaries: {
            forbid_inline_secrets: true,
            approval_required_for: [
              'credential_use',
              'points_portal_redirect',
              'booking_confirmation',
              'payment_execution',
            ],
          },
          preferred_booking_sites: [
            {
              site: 'rakuten_travel',
              priority: 1,
              categories: ['hotel', 'package'],
              reason:
                'Use Rakuten Travel for travel booking while preserving points-portal routing evidence.',
            },
          ],
          login_methods: [
            {
              site: 'rakuten_travel',
              preferred_method: 'rakuten_id',
              credential_ref: 'browser://profile/rakuten-travel',
              approval_required: true,
            },
          ],
          payment_policy: {
            prefer: ['points_earning', 'free_cancellation', 'onsite_payment'],
            allow_prepaid: true,
            payment_method_refs: ['secret://wallet/main-card'],
            require_confirmation_if: [
              'nonrefundable',
              'total_amount_over_budget',
              'points_terms_unclear',
              'payment_execution',
            ],
          },
          site_selection_policy: {
            decision_mode: 'ask_when_uncertain',
            compare_dimensions: [
              'price',
              'points',
              'coupon',
              'login_friction',
              'cancellation',
              'familiarity',
              'privacy',
            ],
            ask_user_when: [
              'sale_possible',
              'price_gap_unclear',
              'points_advantage_unclear',
              'multiple_top_candidates',
              'login_friction_tradeoff',
              'new_service_category',
              'user_requested_precheck',
            ],
            max_questions_per_turn: 2,
            preflight_question_sets: [
              {
                label: 'Restaurant preflight',
                categories: ['restaurant'],
                questions: ['人数と希望時間はいつですか?', '苦手食材や個室の要否はありますか?'],
              },
            ],
            favorite_site_groups: [
              {
                label: 'Travel default',
                categories: ['hotel', 'package'],
                preferred_sites: ['rakuten_travel', 'jalan', 'booking_com'],
                backup_sites: ['official_site'],
                notes:
                  'Check sales and points first, then ask before switching away from the usual favorites.',
              },
              {
                label: 'Restaurant default',
                categories: ['restaurant'],
                preferred_sites: ['tabelog', 'yoyaku', 'gurunavi'],
                backup_sites: ['official_site'],
                notes:
                  'Prefer the lowest-friction reservation path unless a campaign changes the decision.',
              },
              {
                label: 'Shopping default',
                categories: ['shopping'],
                preferred_sites: ['official_site', 'rakuten', 'amazon'],
                backup_sites: ['kakaku', 'yodobashi'],
                notes:
                  'Prefer official campaigns or familiar shopping portals unless the sale gap is material.',
              },
              {
                label: 'Medical scheduling default',
                categories: ['medical'],
                preferred_sites: ['official_site', 'clinic_portal', 'line'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the most privacy-preserving appointment path and ask before sharing any sensitive details.',
              },
              {
                label: 'Subscription default',
                categories: ['subscription'],
                preferred_sites: ['official_site', 'app_store', 'member_portal'],
                backup_sites: ['phone', 'support_chat'],
                notes:
                  'Prefer the official account center and ask before cancellation, downgrade, or payment changes.',
              },
              {
                label: 'Home service default',
                categories: ['home_service'],
                preferred_sites: ['official_site', 'local_booking', 'support_chat'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the clearest scheduling path and compare availability, estimate terms, and access constraints.',
              },
              {
                label: 'Family scheduling default',
                categories: ['family'],
                preferred_sites: ['official_site', 'calendar_app', 'support_chat'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the simplest scheduling path when coordinating family timing, pickups, or school deadlines.',
              },
              {
                label: 'Gifts default',
                categories: ['gifts'],
                preferred_sites: ['official_site', 'marketplace', 'local_shop'],
                backup_sites: ['phone', 'chat'],
                notes:
                  'Compare delivery date, wrapping, and message-card options before switching away from the normal favorites.',
              },
            ],
            sale_signal_policy: {
              check_sales_before_decision: true,
              recheck_if_material: true,
              material_threshold: '10%',
              preferred_sale_sources: ['official_site', 'points_portal', 'site_campaign_page'],
            },
          },
          points_portal_policy: {
            enabled: true,
            preferred_portals: [
              {
                portal: 'moppy',
                priority: 1,
              },
            ],
            routing_rules: [
              {
                merchant: 'rakuten_travel',
                use_points_portal: true,
                clickout_usecase_ref:
                  'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json',
                preferred_execution_mode: 'simulation',
              },
            ],
            require_confirmation_if: [
              'reward_rate_unknown',
              'tracking_cookie_blocked',
              'terms_changed',
              'coupon_conflict',
              'app_transition_required',
              'payment_execution',
            ],
            evidence_required: [
              'portal_name',
              'merchant_page',
              'reward_rate',
              'terms_snapshot',
              'timestamp',
              'final_booking_site',
              'clickout_confirmation',
              'tracking_warning',
            ],
            fallback_rule: 'manual_review',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'booking-preference-profile',
          profile_id: 'travel-points-routing-example',
          preferred_booking_sites: [],
          payment_policy: {
            prefer: ['free_cancellation'],
            allow_prepaid: true,
            require_confirmation_if: ['payment_execution'],
          },
        },
      ],
    },
    {
      id: 'presentation-preference-profile',
      schemaPath: 'knowledge/public/schemas/presentation-preference-profile.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/schemas/presentation-preference-profile.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'presentation-preference-profile',
          profile_id: 'business-deck-default',
          brief_question_sets: [],
          theme_sets: [],
        },
      ],
    },
    {
      id: 'narrated-video-preference-profile',
      schemaPath: 'knowledge/public/schemas/narrated-video-preference-profile.schema.json',
      validPayloads: [
        readGovernanceJson(
          'knowledge/public/schemas/narrated-video-preference-profile.example.json'
        ),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-preference-profile',
          profile_id: 'video-default',
          brief_question_sets: [],
          theme_sets: [],
          publish_policy: {
            default_target: 'youtube',
            default_visibility: 'unlisted',
            require_human_approval_before_publish: true,
          },
        },
      ],
    },
    {
      id: 'narrated-video-publish-plan',
      schemaPath: 'knowledge/public/schemas/narrated-video-publish-plan.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/schemas/narrated-video-publish-plan.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-publish-plan',
          version: '1.0.0',
          target: 'youtube',
          title: '',
          visibility: 'unlisted',
          approval_boundary: 'before_public_release',
          video_artifact_ref: '',
        },
      ],
    },
    {
      id: 'narrated-video-upload-package',
      schemaPath: 'knowledge/public/schemas/narrated-video-upload-package.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/schemas/narrated-video-upload-package.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-upload-package',
          version: '1.0.0',
          publish_plan_ref: '',
          target_url: 'https://studio.youtube.com',
          video_artifact_ref: '',
          visibility: 'unlisted',
          approval_boundary: 'before_public_release',
          checklist: [],
        },
      ],
    },
    {
      id: 'meeting-operations-profile',
      schemaPath: 'knowledge/public/schemas/meeting-operations-profile.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/schemas/meeting-operations-profile.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'meeting-operations-profile',
          profile_id: 'meeting-default',
          brief_question_sets: [],
          role_sets: [],
          facilitation_policy: {
            ask_before_join: true,
            ask_before_speaking: true,
            ask_before_shared_decision: true,
          },
          tracking_policy: {
            default_follow_up_channel: 'task_session',
            default_tracking_cadence: 'daily',
          },
          exit_policy: {
            stop_after_agenda_complete: true,
            stop_on_missing_authority: true,
          },
        },
      ],
    },
    {
      id: 'meeting-operations-brief',
      schemaPath: 'knowledge/public/schemas/meeting-operations-brief.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/schemas/meeting-operations-brief.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'meeting-operations-brief',
          version: '1.0.0',
          intent: 'meeting_operations',
          meeting_title: '',
          meeting_url: '',
          platform: 'teams',
          purpose: 'planning',
          primary_role: 'facilitator',
          desired_outcomes: [],
          exit_conditions: [],
        },
      ],
    },
    {
      id: 'mobile-app-profile-index',
      schemaPath: 'knowledge/public/schemas/mobile-app-profile-index.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          profiles: [
            {
              id: 'example-mobile-login-passkey',
              platform: 'android',
              title: 'Example Mobile Login + Passkey',
              path: 'knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json',
              description:
                'Example Android app profile covering launch, login form selectors, and passkey trigger selectors.',
              tags: ['android', 'login', 'passkey', 'example'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          profiles: [
            {
              id: '',
              platform: 'desktop',
              title: '',
              path: 'missing.json',
              description: '',
              tags: ['ok', 1],
            },
          ],
        },
      ],
    },
    {
      id: 'web-app-profile-index',
      schemaPath: 'knowledge/public/schemas/web-app-profile-index.schema.json',
      validPayloads: [
        {
          profiles: [
            {
              id: 'example-web-login-guarded',
              platform: 'browser',
              title: 'Example Web Login + Guarded Routes',
              path: 'knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json',
              description:
                'Shared profile for a Web app with login, guarded routes, and a debug-only session export route.',
              tags: ['browser', 'session-handoff', 'login', 'guarded-routes', 'example'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          profiles: [
            {
              id: '',
              platform: 'desktop',
              title: '',
              path: 'missing-web.json',
              description: '',
              tags: ['ok', 1],
            },
          ],
        },
      ],
    },
    {
      id: 'browser-passkey-providers',
      schemaPath: 'knowledge/public/schemas/browser-passkey-providers.schema.json',
      validPayloads: [
        {
          default_provider: 'webauthn.io',
          providers: {
            'webauthn.io': {
              baseUrl: 'https://webauthn.io/',
              usernameSelector: '#input-email',
              registerSelector: '#register-button',
              authenticateSelector: '#login-button',
              postAuthUrlIncludes: '/profile',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          default_provider: 'webauthn.io',
          providers: {
            'webauthn.io': {
              baseUrl: 'https://webauthn.io/',
              usernameSelector: '#input-email',
            },
          },
        },
      ],
    },
    {
      id: 'browser-execution-presets',
      schemaPath: 'knowledge/public/schemas/browser-execution-presets.schema.json',
      validPayloads: [
        {
          default_preset: 'standard-web-auth',
          presets: {
            'standard-web-auth': {
              default_email: 'tester@example.com',
              default_password: 'debug-password',
              handoff_output_path: 'active/shared/tmp/browser/generated-web-session-handoff.json',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          default_preset: 42,
          presets: {
            'standard-web-auth': {
              default_email: 'tester@example.com',
            },
          },
        },
      ],
    },
    {
      id: 'service-endpoints',
      schemaPath: 'knowledge/public/schemas/service-endpoints.schema.json',
      validPayloads: [
        {
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            moltbook: {
              base_url: 'https://www.moltbook.com/api/v1',
            },
            slack: {
              base_url: 'https://slack.com/api',
              preset_path: 'knowledge/public/orchestration/service-presets/slack.json',
            },
            github: {
              base_url: 'https://api.github.com',
              preset_path: 'knowledge/public/orchestration/service-presets/github.json',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            broken: {},
          },
        },
      ],
    },
    {
      id: 'actuator-request-archetypes',
      schemaPath: 'knowledge/public/schemas/actuator-request-archetypes.schema.json',
      validPayloads: [
        {
          default_archetype: 'structured-delivery',
          archetypes: [
            {
              id: 'web-design-clone-delivery',
              trigger_keywords: [
                'web',
                'website',
                'lp',
                'landing page',
                'design',
                '踏襲',
                'サイト',
              ],
              summary_template:
                'Reference Web experience plus new concept, with implementation and validation artifacts.',
              normalized_scope: [
                'reference-observation',
                'design-clone',
                'implementation',
                'test-pack',
              ],
              target_actuators: ['browser-actuator', 'modeling-actuator', 'media-actuator'],
              deliverables: ['web implementation', 'design spec', 'test results'],
              required_inputs: [
                'reference source',
                'preserved elements',
                'new concept',
                'target environment',
              ],
            },
            {
              id: 'structured-delivery',
              trigger_keywords: ['作って', 'やって', 'まとめて', '改善', 'deliver', 'build'],
              summary_template:
                'Generic structured delivery request requiring normalization before execution.',
              normalized_scope: ['request-normalization', 'artifact-plan', 'execution-plan'],
              target_actuators: ['orchestrator-actuator', 'modeling-actuator', 'media-actuator'],
              deliverables: ['execution brief', 'resolution plan'],
              required_inputs: [
                'objective',
                'target artifact',
                'environment',
                'acceptance criteria',
              ],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          default_archetype: 'structured-delivery',
          archetypes: [
            {
              id: 'broken-archetype',
              trigger_keywords: [],
              summary_template: '',
              normalized_scope: [],
              target_actuators: [],
              deliverables: [],
              required_inputs: [],
            },
          ],
        },
      ],
    },
    {
      id: 'points-portal-clickout-usecase',
      schemaPath: 'knowledge/public/schemas/points-portal-clickout-usecase.schema.json',
      validPayloads: [
        {
          kind: 'points-portal-clickout-usecase',
          usecase_id: 'moppy-rakuten-travel',
          mode: 'simulation',
          points_portal: {
            id: 'moppy',
            display_name: 'Moppy',
            account_ref: 'personal/points/moppy',
          },
          merchant: {
            id: 'rakuten_travel',
            display_name: 'Rakuten Travel',
            account_ref: 'personal/booking/rakuten-travel',
          },
          auth_strategy: {
            type: 'dedicated_browser_profile',
            browser_profile_ref: 'active/shared/runtime/browser/profiles/moppy-rakuten-travel',
            approval_required: true,
          },
          portal_detail_url: 'https://pc.moppy.jp/shopping/detail.php?site_id=903&track_ref=sea',
          clickout: {
            selector: 'form#toClient > button:nth-of-type(1)',
            selector_strategy: 'css',
            button_text_hint: 'POINT GET!',
            operator_confirmation_required: true,
          },
          landing_match: {
            url_includes: 'travel.rakuten.co.jp',
            title_includes: '楽天トラベル',
          },
          blocked_actions: [
            'reservation_confirmation',
            'payment_execution',
            'cancellation',
            'profile_mutation',
            'credential_export',
            'session_handoff_export',
          ],
          evidence_required: [
            'portal_name',
            'merchant_page',
            'reward_rate',
            'terms_snapshot',
            'timestamp',
            'portal_detail_screenshot',
            'clickout_confirmation',
            'tabs_before_clickout',
            'tabs_after_landing',
            'merchant_landing_snapshot',
            'merchant_landing_screenshot',
            'network_after_landing',
            'exported_adf',
            'tracking_warning',
          ],
          success_criteria: {
            landing_url_includes: 'travel.rakuten.co.jp',
            landing_title_includes: '楽天トラベル',
            handoff_export_absent: true,
            blocked_actions_not_executed: true,
            merchant_landing_captured: true,
          },
          artifact_policy: {
            forbid_session_handoff_export: true,
            allowed_artifact_roots: ['active/shared/tmp/browser', 'active/shared/runtime/browser'],
            retain_browser_profile: true,
            delete_continue_files: true,
          },
          preflight: {
            require_clickout_selector: true,
            require_landing_match: true,
            require_blocked_actions: true,
            deny_ops: [
              'export_session_handoff',
              'payment_execution',
              'reservation_confirmation',
              'profile_mutation',
            ],
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'points-portal-clickout-usecase',
          usecase_id: 'moppy-rakuten-travel',
          mode: 'simulation',
          points_portal: {
            id: 'moppy',
            display_name: 'Moppy',
          },
          merchant: {
            id: 'rakuten_travel',
            display_name: 'Rakuten Travel',
          },
          auth_strategy: {
            type: 'dedicated_browser_profile',
            approval_required: false,
          },
          portal_detail_url: 'https://pc.moppy.jp/shopping/detail.php?site_id=903&track_ref=sea',
          clickout: {
            selector: 'form#toClient > button:nth-of-type(1)',
            operator_confirmation_required: true,
          },
          landing_match: {
            url_includes: 'travel.rakuten.co.jp',
          },
          blocked_actions: ['reservation_confirmation'],
          evidence_required: ['portal_name'],
          success_criteria: {
            landing_url_includes: 'travel.rakuten.co.jp',
            handoff_export_absent: true,
            blocked_actions_not_executed: true,
            merchant_landing_captured: true,
          },
          artifact_policy: {
            forbid_session_handoff_export: true,
            allowed_artifact_roots: ['active/shared/tmp/browser'],
            retain_browser_profile: true,
            delete_continue_files: true,
          },
          preflight: {
            require_clickout_selector: true,
            require_landing_match: true,
            require_blocked_actions: true,
            deny_ops: ['payment_execution'],
          },
        },
      ],
    },
    {
      id: 'secret-mutation-approval',
      schemaPath: 'schemas/secret-mutation-approval.schema.json',
      validPayloads: [
        {
          request_id: 'req-schema-1',
          kind: 'secret_mutation',
          status: 'pending',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          requested_by: {
            surface: 'terminal',
            actor_id: 'agent-1',
            actor_role: 'ops',
          },
          target: {
            service_id: 'github',
            secret_key: 'token',
            mutation: 'rotate',
          },
          justification: {
            reason: 'Token rotation is due.',
          },
          risk: {
            level: 'high',
            restart_scope: 'service',
            requires_strong_auth: true,
          },
          workflow: {
            workflow_id: 'wf-schema-1',
            mode: 'all_required',
            required_roles: ['ops'],
            stages: [
              {
                stage_id: 'stage-1',
                required_roles: ['ops'],
              },
            ],
            approvals: [
              {
                role: 'ops',
                status: 'pending',
              },
            ],
          },
        },
      ],
      invalidPayloads: [
        {
          request_id: 'req-invalid-1',
          kind: 'secret_mutation',
          status: 'pending',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          requested_by: {
            surface: 'terminal',
            actor_id: 'agent-1',
            actor_role: 'ops',
          },
          target: {
            service_id: 'github',
            secret_key: 'token',
            mutation: 'rotate',
          },
          justification: {
            reason: 'missing workflow',
          },
          risk: {
            level: 'high',
            restart_scope: 'service',
            requires_strong_auth: true,
          },
        },
      ],
    },
    {
      id: 'task-session',
      schemaPath: 'knowledge/public/schemas/task-session.schema.json',
      validPayloads: [
        createTaskSession({
          sessionId: 'TSK-schema-1',
          surface: 'presence',
          taskType: 'presentation_deck',
          goal: {
            summary: 'Create a deck',
            success_condition: 'pptx exists',
          },
          payload: {
            deck_purpose: 'proposal',
          },
        }),
      ],
      invalidPayloads: [
        {
          session_id: 'TSK-invalid-1',
          surface: 'presence',
          task_type: 'presentation_deck',
          status: 'planning',
          mode: 'interactive',
          history: [],
          updated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'task-session-capture-photo',
      schemaPath: 'knowledge/public/schemas/task-session-capture-photo.schema.json',
      validPayloads: [
        {
          camera_intent: 'record',
          device_preference: 'rear-camera',
          save_path: 'active/shared/tmp/photo.jpg',
          post_process: ['compress'],
          subject_hint: '記録用の写真',
        },
      ],
      invalidPayloads: [
        {
          device_preference: 'rear-camera',
          save_path: 'active/shared/tmp/photo.jpg',
        },
      ],
    },
    {
      id: 'work-policy',
      schemaPath: 'knowledge/public/schemas/work-policy.schema.json',
      validPayloads: [workPolicy],
      invalidPayloads: [
        {
          version: '1.0.0',
          specialist_routing: {
            rules: [],
            fallback_specialist_id: 42,
          },
          profile_routing: {
            defaults: {
              execution_boundary_profile_id: 'default_governed_execution',
              runtime_design_profile_id: 'single_actor_delivery',
            },
          },
          design_rules: {
            process_checklist_rules: [],
            execution_shape_rules: [],
            intent_label_rules: [],
          },
        },
      ],
    },
    {
      id: 'surface-provider-manifests',
      schemaPath: 'knowledge/public/schemas/surface-provider-manifests.schema.json',
      validPayloads: [surfaceProviderManifests],
      invalidPayloads: [
        {
          version: '1.0.0',
          providers: {
            slack: surfaceProviderManifests.providers.slack,
          },
        },
      ],
    },
    {
      id: 'surface-policy',
      schemaPath: 'knowledge/public/schemas/surface-policy.schema.json',
      validPayloads: [surfacePolicy],
      invalidPayloads: [
        {
          version: '1.0.0',
          routing: {
            text_routing: {
              greeting_patterns: [],
              receiver_rules: [],
            },
            compiled_flow_rules: [],
          },
        },
      ],
    },
    {
      id: 'standard-intents',
      schemaPath: 'knowledge/public/schemas/standard-intents.schema.json',
      validPayloads: [
        {
          version: '2.0.0',
          ux_contract: 'Intent -> Plan -> State -> Result',
          notes: [
            'This catalog is user-facing first. It describes what people ask Kyberion to do.',
            'Mission, task session, actuator, and ADF details remain backend execution concerns unless inspection is needed.',
            'Legacy operator and maintenance intents remain available for internal and operator use.',
          ],
          intents: [
            {
              id: 'capture-photo',
              category: 'outcome_execution',
              legacy_category: 'surface',
              exposed_to_surface: true,
              target: 'outcome',
              action: 'create',
              object: 'artifact_image',
              execution_shape: 'task_session',
              mission_class: 'content_and_media',
              risk_profile: 'review_required',
              description: 'Capture a photo for record keeping, sharing, or OCR source use.',
              surface_examples: ['ちょっと写真をとって'],
              outcome_ids: ['artifact:image'],
              trigger_keywords: ['写真', '撮影', 'photo', 'picture', 'camera', 'OCR'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: '2.0.0',
          intents: [
            {
              id: '',
              category: 'outcome_execution',
              legacy_category: '',
              exposed_to_surface: true,
              description: '',
              trigger_keywords: [],
            },
          ],
        },
      ],
    },
    {
      id: 'intent-domain-ontology',
      schemaPath: 'knowledge/public/schemas/intent-domain-ontology.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/public/governance/intent-domain-ontology.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          intents: [
            {
              intent_id: '',
              category: 'outcome_execution',
              legacy_category: 'surface',
              target: 'outcome',
              action: 'create',
              object: 'project',
              exposed_to_surface: true,
              execution_shape: 'task_session',
              mission_class: 'product_delivery',
              workflow_template: 'single-track-default',
              team_template: 'default',
              risk_profile: 'review_required',
              outcome_ids: [],
              actuator_requirements: [],
              readiness_required: [],
              evidence_required: [],
            },
          ],
        },
      ],
    },
    {
      id: 'a2a-task-contract',
      schemaPath: 'knowledge/public/schemas/a2a-task-contract.schema.json',
      validPayloads: [
        {
          intent: 'request_mission_work',
          text: '進捗をまとめて',
          context: {
            mission_id: 'MSN-schema-1',
            team_role: 'mission-controller',
            execution_mode: 'task',
            channel: 'slack',
          },
        },
      ],
      invalidPayloads: [
        {
          intent: 'request_mission_work',
          text: '進捗をまとめて',
          context: {
            mission_id: 'MSN-schema-1',
          },
        },
      ],
    },
    {
      id: 'intent-resolution-policy',
      schemaPath: 'knowledge/public/schemas/intent-resolution-policy.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          catalog_scoring: {
            exact_intent_id_confidence: 1,
            keyword_base_confidence: 0.55,
            keyword_increment: 0.12,
            keyword_max_confidence: 0.92,
            exact_surface_example_confidence: 0.98,
            surface_containment_confidence: 0.84,
            surface_overlap_increment: 0.03,
            surface_overlap_max_confidence: 0.95,
            selected_confidence_threshold: 0.45,
            catalog_intent_category: 'outcome_execution',
          },
          legacy_candidates: [
            {
              id: 'capture-photo-heuristic',
              intent_id: 'capture-photo',
              confidence: 0.88,
              source: 'legacy',
              reasons: ['legacy capture-photo heuristic'],
              patterns: [{ type: 'regex', value: '(写真|撮影|photo|picture|camera)' }],
              resolution: {
                shape: 'task_session',
                task_kind: 'capture_photo',
                result_shape: 'artifact',
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          catalog_scoring: {
            exact_intent_id_confidence: 1,
            keyword_base_confidence: 0.55,
            keyword_increment: 0.12,
            keyword_max_confidence: 0.92,
            exact_surface_example_confidence: 0.98,
            surface_containment_confidence: 0.84,
            surface_overlap_increment: 0.03,
            surface_overlap_max_confidence: 0.95,
            selected_confidence_threshold: 0.45,
            catalog_intent_category: 'outcome_execution',
          },
          legacy_candidates: [
            {
              id: 'broken',
              intent_id: 'capture-photo',
              confidence: 0.88,
              source: 'legacy',
              reasons: ['legacy capture-photo heuristic'],
              patterns: [],
            },
          ],
        },
      ],
    },
    {
      id: 'task-session-policy',
      schemaPath: 'knowledge/public/schemas/task-session-policy.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          intents: [
            {
              id: 'capture-photo',
              task_type: 'capture_photo',
              goal: {
                summary: 'Capture a photo for the requested purpose',
                success_condition: 'A photo artifact is captured and stored in a governed path.',
              },
              requirements: {
                rules: [
                  {
                    requirement: 'camera_intent',
                    omit_when: [
                      { type: 'regex', value: '(記録用|共有用|reference|record|share|ocr)' },
                    ],
                  },
                ],
              },
              payload: {
                fields: [
                  {
                    field: 'camera_intent',
                    default: 'record',
                    rules: [
                      { when: [{ type: 'regex', value: 'ocr' }], value: 'ocr_source' },
                      { when: [{ type: 'regex', value: '(共有|share)' }], value: 'share' },
                      { when: [{ type: 'regex', value: '(記録|record)' }], value: 'record' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'schedule-coordination',
              task_type: 'service_operation',
              goal: {
                summary: 'Coordinate or reschedule a calendar within declared authority boundaries',
                success_condition:
                  'The updated schedule, constraints, and follow-up path are recorded.',
              },
              requirements: {
                default_missing: [
                  'schedule_scope',
                  'date_range',
                  'fixed_constraints',
                  'calendar_action_boundary',
                ],
              },
              payload: {
                static: {
                  intent_id: 'schedule-coordination',
                  execution_shape: 'task_session',
                },
              },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          intents: [
            {
              id: '',
              task_type: 'capture_photo',
              goal: {
                summary: 'Capture a photo for the requested purpose',
                success_condition: 'A photo artifact is captured and stored in a governed path.',
              },
              payload: {
                fields: [],
              },
            },
          ],
        },
      ],
    },
    ...additionalGovernanceChecks,
    {
      id: 'intent-contract',
      schemaPath: 'knowledge/public/schemas/intent-contract.schema.json',
      validPayloads: [
        {
          kind: 'intent-contract',
          source_text: '提案資料を作って',
          intent_id: 'generate-presentation',
          capability_bundle_id: 'browser-exploration-governed',
          goal: {
            summary: 'Create a presentation deck',
            success_condition: 'A governed PPTX draft is prepared.',
          },
          resolution: {
            execution_shape: 'task_session',
            task_type: 'presentation_deck',
          },
          required_inputs: [],
          outcome_ids: ['artifact:pptx'],
          approval: {
            requires_approval: false,
          },
          delivery_mode: 'one_shot',
          clarification_needed: false,
          confidence: 0.92,
          why: 'The request is a governed presentation generation task.',
        },
      ],
      invalidPayloads: [
        {
          kind: 'intent-contract',
          source_text: '提案資料を作って',
          intent_id: 'generate-presentation',
          goal: {
            summary: 'Create a presentation deck',
            success_condition: 'A governed PPTX draft is prepared.',
          },
          resolution: {
            execution_shape: 'invalid_shape',
          },
          required_inputs: [],
          outcome_ids: ['artifact:pptx'],
          approval: {
            requires_approval: false,
          },
          delivery_mode: 'one_shot',
          clarification_needed: false,
          confidence: 0.92,
          why: 'The request is a governed presentation generation task.',
        },
      ],
    },
    {
      id: 'agent-routing-decision',
      schemaPath: 'knowledge/public/schemas/agent-routing-decision.schema.json',
      validPayloads: [
        {
          kind: 'agent-routing-decision',
          source_text: '今週の進捗レポートを作って',
          intent_id: 'generate-report',
          mode: 'subagent',
          scope: 'single_artifact',
          autonomy: 'medium',
          boundary_crossing: false,
          fanout: 'review',
          owner: 'report-drafting-agent',
          delegates: ['fact-check-agent', 'editor-agent'],
          artifact_count: 1,
          stop_condition: 'A governed report draft exists and the owner has accepted it.',
          rationale:
            'The request is review-heavy and benefits from a bounded drafting worker plus a lightweight review pass.',
        },
      ],
      invalidPayloads: [
        {
          kind: 'agent-routing-decision',
          source_text: '今週の進捗レポートを作って',
          intent_id: 'generate-report',
          mode: 'prompt',
          scope: 'single_artifact',
          autonomy: 'medium',
          boundary_crossing: false,
          fanout: 'review',
          owner: 'report-drafting-agent',
          delegates: ['fact-check-agent', 'editor-agent'],
          artifact_count: 0,
          stop_condition: 'A governed report draft exists and the owner has accepted it.',
          rationale:
            'The request is review-heavy and benefits from a bounded drafting worker plus a lightweight review pass.',
        },
      ],
    },
    {
      id: 'pipeline-adf',
      schemaPath: 'knowledge/public/schemas/pipeline-adf.schema.json',
      validPayloads: [
        {
          action: 'pipeline',
          name: 'sample',
          steps: [
            { id: 'step1', type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
          ],
        },
      ],
      invalidPayloads: [
        {
          action: 'pipeline',
          name: 'sample',
        },
      ],
    },
    {
      id: 'distill-candidate-record',
      schemaPath: 'knowledge/public/schemas/distill-candidate-record.schema.json',
      validPayloads: [
        createDistillCandidateRecord({
          source_type: 'task_session',
          title: 'Promote reusable presentation pattern',
          summary: 'A presentation flow can be reused as a candidate.',
          status: 'proposed',
          target_kind: 'pattern',
        }),
      ],
      invalidPayloads: [
        {
          candidate_id: 'DSC-invalid-1',
          source_type: 'task_session',
          summary: 'Missing title should fail',
          status: 'proposed',
          target_kind: 'pattern',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
          updated_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'promoted-pattern-record',
      schemaPath: 'knowledge/public/schemas/generated-pattern-record.schema.json',
      validPayloads: [promotedPattern],
      invalidPayloads: [
        {
          record_id: 'PROM-invalid-1',
          kind: 'pattern',
          tier: 'public',
          title: 'Missing fields',
          summary: 'This should fail because required pattern fields are missing',
          candidate_id: 'DSC-invalid-2',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'promoted-sop-record',
      schemaPath: 'knowledge/public/schemas/generated-sop-record.schema.json',
      validPayloads: [promotedSop],
      invalidPayloads: [
        {
          record_id: 'PROM-invalid-2',
          kind: 'sop_candidate',
          tier: 'confidential',
          title: 'Missing steps',
          summary: 'This should fail because required SOP fields are missing',
          candidate_id: 'DSC-invalid-3',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'promoted-knowledge-hint-record',
      schemaPath: 'knowledge/public/schemas/generated-knowledge-hint-record.schema.json',
      validPayloads: [promotedHint],
      invalidPayloads: [
        {
          record_id: 'PROM-invalid-3',
          kind: 'knowledge_hint',
          tier: 'public',
          title: 'Missing triggers',
          summary: 'This should fail because required hint fields are missing',
          candidate_id: 'DSC-invalid-4',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'promoted-report-template-record',
      schemaPath: 'knowledge/public/schemas/generated-report-template-record.schema.json',
      validPayloads: [promotedTemplate],
      invalidPayloads: [
        {
          record_id: 'PROM-invalid-4',
          kind: 'report_template',
          tier: 'public',
          title: 'Missing template sections',
          summary: 'This should fail because required template fields are missing',
          candidate_id: 'DSC-invalid-5',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
  ];
}

function main() {
  const ajv = new AjvCtor({ allErrors: true });
  addFormats(ajv);
  const ajv2020 = new AjvCtor({ allErrors: true, validateSchema: false });
  addFormats(ajv2020);
  const violations: string[] = [];

  for (const check of createChecks()) {
    const validate = compileSchemaFromPath(ajv, pathResolver.rootResolve(check.schemaPath));
    for (const payload of check.validPayloads) {
      const ok = validate(payload);
      if (!ok) {
        violations.push(
          `${check.id}: expected valid payload to pass (${JSON.stringify(validate.errors || [])})`
        );
      }
    }
    for (const payload of check.invalidPayloads) {
      const ok = validate(payload);
      if (ok) {
        violations.push(`${check.id}: expected invalid payload to fail`);
      }
    }
  }

  const a2uiValidate = compileSchemaFromPath(
    ajv2020,
    pathResolver.rootResolve('schemas/a2ui-message.schema.json')
  );
  const a2uiMessages = [
    {
      createSurface: {
        surfaceId: 'computer-surface-schema',
        catalogId: 'computer-surface',
        title: 'Computer Surface',
      },
    },
    {
      updateComponents: {
        surfaceId: 'computer-surface-schema',
        components: [
          {
            id: 'comp-1',
            type: 'text',
            props: { value: 'hello' },
          },
        ],
      },
    },
  ];
  for (const payload of a2uiMessages) {
    const ok = a2uiValidate(payload);
    if (!ok) {
      violations.push(
        `a2ui-message: expected valid payload to pass (${JSON.stringify(a2uiValidate.errors || [])})`
      );
    }
  }
  const invalidA2ui = a2uiValidate({
    createSurface: {
      catalogId: 'computer-surface',
    },
  });
  if (invalidA2ui) {
    violations.push('a2ui-message: expected invalid payload to fail');
  }

  if (violations.length > 0) {
    console.error('[check:contract-schemas] violations detected:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[check:contract-schemas] OK');
}

main();
