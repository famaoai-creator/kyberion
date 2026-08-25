import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  buildPromotedMemoryRecord,
  createDistillCandidateRecord,
  resolveIntentResolutionContract,
  createNextActionContract,
  createOutcomeContract,
  createTaskSession,
  safeExistsSync,
  safeReaddir,
} from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';
import {
  findUnmanagedGoldenScenarioCatalogs,
  readAgentProfilePayloads,
  readAuthorityRolePayloads,
  readGovernanceJson,
  readSpecialistPayloads,
  readSurfaceManifestPayloads,
  readSurfaceProviderCatalogPayloads,
  readTeamRolePayloads,
  readVoiceProfilePayloads,
  ContractCheck,
} from './check_contract_schemas_shared.js';
import { createProductionEvidenceRegisterChecks } from './check_contract_schemas_evidence_checks.js';
import { createPolicyAndManifestChecks } from './check_contract_schemas_policy_checks.js';
import { createContractSchemaChecksPart1 } from './check_contract_schemas_checks_1.js';
import { createContractSchemaChecksPart2 } from './check_contract_schemas_checks_2.js';
import { createContractSchemaChecksPart3 } from './check_contract_schemas_checks_3.js';
import { createServiceChecks } from './check_contract_schemas_service_checks.js';
import { createAjv, createAjv2020 } from '@agent/core/foundation';

const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function createChecks(): ContractCheck[] {
  const workPolicy = readGovernanceJson('knowledge/product/governance/work-policy.json');
  const surfaceProviderManifests = readGovernanceJson(
    'knowledge/product/governance/surface-provider-manifests.json'
  );
  const surfacePolicy = readGovernanceJson('knowledge/product/governance/surface-policy.json');

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
      // Intent-driven automation: substrate-neutral procedure catalog (P0 frozen contract).
      // Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §6
      id: 'procedures',
      schemaPath: 'knowledge/product/schemas/procedures.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/orchestration/procedures.json'),
        {
          schema_version: 'procedures.v1',
          procedures: [
            {
              procedure_id: 'attendance.approve.kingoftime',
              substrate: 'browser',
              adapter: {
                recorder: 'chrome-extension',
                executor: 'extension_session',
                recording_ref:
                  'active/shared/runtime/recordings/attendance-approve-kingoftime.json',
              },
              target: { name: 'King of Time', origins: ['https://s2.kingtime.jp'] },
              intent_phrases: ['勤怠の承認', 'approve attendance'],
              execution_substrate: 'extension',
              pipeline_ref: 'pipelines/browser/attendance-approve-kingoftime.json',
              required_inputs: [
                { name: 'target_period', label: '対象期間', type: 'string', optional: true },
              ],
              required_secrets: [{ name: 'kingoftime_login', scope: 'confidential/{project}' }],
              risk_class: 'high',
              golden_scenario_ref: 'knowledge/product/golden/attendance-approve-kingoftime.v1.json',
              version: '1.0.0',
              status: 'active',
            },
            {
              procedure_id: 'deal.intake.jira-slack-box',
              substrate: 'service',
              adapter: { recorder: 'service-capture', executor: 'service:preset' },
              target: { name: 'Deal Intake', services: ['jira', 'slack', 'box'] },
              intent_phrases: ['起票してSlack通知してBoxに格納'],
              pipeline_ref: 'pipelines/service/deal-intake.json',
              risk_class: 'high',
              version: '1.0.0',
              status: 'active',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'procedures.v1',
          procedures: [{ procedure_id: 'x', substrate: 'quantum' }],
        },
        {
          schema_version: 'procedures.v1',
          procedures: [
            {
              procedure_id: 'x',
              substrate: 'browser',
              adapter: { recorder: 'a', executor: 'b' },
              target: { name: 'n' },
              intent_phrases: [],
              pipeline_ref: 'p',
              risk_class: 'high',
              version: '1.0.0',
              status: 'active',
            },
          ],
        },
      ],
    },
    {
      id: 'desktop-pipeline',
      schemaPath: 'knowledge/product/schemas/desktop-pipeline.schema.json',
      validPayloads: [
        {
          schema_version: 'desktop-pipeline.v1',
          procedure_id: 'desktop.notes.capture',
          executor: 'system',
          recording_ref: 'active/shared/runtime/recordings/desktop.notes.capture.json',
          recording_hash: 'a'.repeat(64),
          steps: [
            {
              step_id: 'desktop-step-1',
              op: 'system:screenshot',
              risk_class: 'read',
              selector: { app: 'Notes' },
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'desktop-pipeline.v1',
          procedure_id: 'desktop.notes.capture',
          executor: 'system',
          recording_ref: 'active/shared/runtime/recordings/desktop.notes.capture.json',
          recording_hash: 'not-a-hash',
          steps: [],
        },
      ],
    },
    {
      id: 'procedure-delta',
      schemaPath: 'knowledge/product/schemas/procedure-delta.schema.json',
      validPayloads: [
        {
          schema_version: 'procedure-delta.v1',
          procedure_id: 'attendance.approve.kingoftime',
          anchor: { step_index: 2, ref_snapshot_hash: 'a'.repeat(64) },
          delta_recording_ref: 'runtime/recordings/delta-1.json',
          reason: 'ambiguity',
          created_at: '2026-06-23T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'procedure-delta.v1',
          procedure_id: 'x',
          anchor: { step_index: 0 },
          delta_recording_ref: 'r',
          reason: 'not_a_reason',
          created_at: '2026-06-23T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'golden-scenario',
      schemaPath: 'knowledge/product/schemas/golden-scenario.schema.json',
      validPayloads: [
        {
          schema_version: 'golden-scenario.v1',
          scenario_id: 'gs-1',
          procedure_id: 'attendance.approve.kingoftime',
          success_conditions: [{ kind: 'text_present', name_contains: '承認が完了しました' }],
          captured_from: 'receipt-123',
          version: '1.0.0',
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'golden-scenario.v1',
          scenario_id: 'gs-1',
          procedure_id: 'x',
          success_conditions: [{ kind: 'telepathy' }],
          captured_from: 'r',
          version: '1.0.0',
        },
      ],
    },
    {
      // Intent-driven automation: service substrate recording (E2E).
      id: 'service-recording',
      schemaPath: 'knowledge/product/schemas/service-recording.schema.json',
      validPayloads: [
        {
          schema_version: 'service-recording.v1',
          recording_id: 'svc-rec-1',
          source: 'service-capture',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'Deal Intake', services: ['jira', 'slack'] },
          steps: [
            {
              step_id: 's1',
              service_id: 'jira',
              action: 'create_issue',
              summary: '起票',
              risk_class: 'high',
              params: { summary: '{{input.title}}' },
              produces: 'issue_key',
            },
            {
              step_id: 's2',
              service_id: 'slack',
              action: 'post_message',
              summary: '通知',
              risk_class: 'high',
              params: { text: '{{channel.issue_key}}' },
              consumes: ['issue_key'],
            },
          ],
          risk_summary: { requires_manual_review: true, approval_required_count: 2 },
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'service-recording.v1',
          recording_id: 'x',
          source: 'service-capture',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'X', services: [] },
          steps: [],
          risk_summary: { requires_manual_review: true, approval_required_count: 0 },
        },
      ],
    },
    {
      // Desktop UI automation contract; execution is approval-gated by the dispatcher.
      id: 'desktop-recording',
      schemaPath: 'knowledge/product/schemas/desktop-recording.schema.json',
      validPayloads: [
        {
          schema_version: 'desktop-recording.v1',
          recording_id: 'dsk-1',
          source: 'desktop-capture',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'Excel', platform: 'darwin' },
          steps: [
            {
              step_id: 'd1',
              op: 'click_element',
              summary: 'OKをクリック',
              risk_class: 'low',
              evidence: ['active_window:application'],
            },
          ],
          risk_summary: { requires_manual_review: true, approval_required_count: 0 },
          recording_hash: 'a'.repeat(64),
          policy_version: 'desktop-policy.v1',
          review: { status: 'pending' },
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'desktop-recording.v1',
          recording_id: 'x',
          source: 'desktop-capture',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'X', platform: 'solaris' },
          steps: [],
          risk_summary: { requires_manual_review: true, approval_required_count: 0 },
        },
      ],
    },
    {
      id: 'desktop-intent',
      schemaPath: 'knowledge/product/schemas/desktop-intent.schema.json',
      validPayloads: [
        {
          schema_version: 'desktop-intent.v1',
          intent: 'Review the desktop workflow',
          source_recording_id: 'DR-1',
          generated_at: '2026-08-09T00:00:00.000Z',
          steps: [
            {
              id: 's1',
              title: 'Observe',
              detail: 'Observe the reviewed target.',
              evidence: ['active_window:application'],
              confidence: 0.9,
              op: 'screenshot',
            },
          ],
          review: { status: 'pending' },
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'desktop-intent.v1',
          intent: '',
          source_recording_id: 'DR-1',
          generated_at: 'not-a-date-but-nonempty',
          steps: [
            {
              id: 's1',
              title: 'Observe',
              detail: 'Observe',
              evidence: [],
              confidence: 2,
              op: 'screenshot',
            },
          ],
          review: { status: 'pending' },
        },
      ],
    },
    {
      // Substrate contract (executor deferred): media generation recipe.
      id: 'media-recipe',
      schemaPath: 'knowledge/product/schemas/media-recipe.schema.json',
      validPayloads: [
        {
          schema_version: 'media-recipe.v1',
          recipe_id: 'med-1',
          source: 'media-distill',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'Explainer Video', medium: 'video' },
          stages: [
            {
              stage_id: 'm1',
              actuator: 'video-composition-actuator',
              summary: 'compose',
              produces: 'render',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'media-recipe.v1',
          recipe_id: 'x',
          source: 'media-distill',
          created_at: '2026-06-24T00:00:00.000Z',
          target: { name: 'X', medium: 'hologram' },
          stages: [],
        },
      ],
    },
    {
      id: 'intent-policy',
      schemaPath: 'knowledge/product/schemas/intent-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/intent-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          delivery: { rules: [] },
        },
      ],
    },
    {
      id: 'reasoning-level-policy',
      schemaPath: 'knowledge/product/schemas/reasoning-level-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/reasoning-level-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          thresholds: {
            low_confidence: 0.65,
          },
          fast_shapes: ['direct_reply'],
          rules: [],
        },
      ],
    },
    ...createProductionEvidenceRegisterChecks(),
    {
      id: 'active-surfaces',
      schemaPath: 'knowledge/product/schemas/runtime-surface-manifest.schema.json',
      validPayloads: [
        ...readSurfaceManifestPayloads(),
        readGovernanceJson('knowledge/product/governance/active-surfaces.json'),
      ],
      invalidPayloads: [
        {
          version: 1,
        },
      ],
    },
    {
      id: 'model-registry',
      schemaPath: 'knowledge/product/schemas/model-registry.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/model-registry.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          default_model_id: 'openai:gpt-5.4',
        },
      ],
    },
    {
      id: 'model-registry-index',
      schemaPath: 'knowledge/product/schemas/model-registry-index.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/model-registry/index.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          default_model_id: 'openai:gpt-5.4',
          model_order: [123],
        },
      ],
    },
    {
      id: 'model-adaptation-policy',
      schemaPath: 'knowledge/product/schemas/model-adaptation-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/model-adaptation-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'harness-capability-registry',
      schemaPath: 'knowledge/product/schemas/harness-capability-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/harness-capability-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'harness-adapter-registry',
      schemaPath: 'knowledge/product/schemas/harness-adapter-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/harness-adapter-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'provider-capability-scan-policy',
      schemaPath: 'knowledge/product/schemas/provider-capability-scan-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/provider-capability-scan-policy.json'),
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
      schemaPath: 'knowledge/product/schemas/capability-lifecycle-procedure.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/capability-lifecycle-procedure.json'),
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
      schemaPath: 'knowledge/product/schemas/capability-bundle-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/capability-bundle-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          bundles: [],
        },
      ],
    },
    {
      id: 'intent-execution-profile-registry',
      schemaPath: 'knowledge/product/schemas/intent-execution-profile-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/intent-execution-profile-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          profiles: [],
        },
      ],
    },
    {
      id: 'execution-receipt-policy',
      schemaPath: 'knowledge/product/schemas/execution-receipt-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/execution-receipt-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-profile-registry',
      schemaPath: 'knowledge/product/schemas/voice-profile-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/voice-profile-registry.json'),
        ...readVoiceProfilePayloads(),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-runtime-policy',
      schemaPath: 'knowledge/product/schemas/voice-runtime-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/voice-runtime-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-engine-registry',
      schemaPath: 'knowledge/product/schemas/voice-engine-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/voice-engine-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'tool-runtime-policy',
      schemaPath: 'knowledge/product/schemas/tool-runtime-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/tool-runtime-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'tool-runtime-registry',
      schemaPath: 'knowledge/product/schemas/tool-runtime-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/tool-runtime-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'voice-sample-ingestion-policy',
      schemaPath: 'knowledge/product/schemas/voice-sample-ingestion-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/voice-sample-ingestion-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'video-composition-template-registry',
      schemaPath: 'knowledge/product/schemas/video-composition-template-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/video-composition-template-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'video-render-runtime-policy',
      schemaPath: 'knowledge/product/schemas/video-render-runtime-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/video-render-runtime-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-classification-policy',
      schemaPath: 'knowledge/product/schemas/mission-classification-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-classification-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'authority-role-index',
      schemaPath: 'knowledge/product/schemas/authority-role-index.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/authority-role-index.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'authority-role-directory',
      schemaPath: 'knowledge/product/schemas/authority-role.schema.json',
      validPayloads: readAuthorityRolePayloads(),
      invalidPayloads: [
        {
          description: 'Missing role',
        },
      ],
    },
    {
      id: 'team-role-index',
      schemaPath: 'knowledge/product/schemas/team-role-index.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/orchestration/team-role-index.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'team-role-directory',
      schemaPath: 'knowledge/product/schemas/team-role.schema.json',
      validPayloads: readTeamRolePayloads(),
      invalidPayloads: [
        {
          description: 'Missing role',
        },
      ],
    },
    {
      id: 'agent-profile-index',
      schemaPath: 'knowledge/product/schemas/agent-profile-index.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/orchestration/agent-profile-index.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'agent-profile-directory',
      schemaPath: 'knowledge/product/schemas/agent-profile-index.schema.json',
      validPayloads: readAgentProfilePayloads(),
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-workflow-catalog',
      schemaPath: 'knowledge/product/schemas/mission-workflow-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-workflow-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'mission-review-gate-registry',
      schemaPath: 'knowledge/product/schemas/mission-review-gate-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-review-gate-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'path-scope-policy',
      schemaPath: 'knowledge/product/schemas/path-scope-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/path-scope-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
    {
      id: 'service-connection-readiness',
      schemaPath: 'knowledge/product/schemas/service-connection-readiness.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          tenant_guard: {
            require_zero_drift: true,
          },
          required_services: {
            comfyui: {
              required_keys_any: ['base_url', 'output_dir'],
            },
            voice: {
              required_keys_any: ['voice_python_bin', 'voice_name'],
            },
          },
        },
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          required_services: {
            comfyui: {},
          },
        },
      ],
    },
    {
      id: 'onboarding-state',
      schemaPath: 'knowledge/product/schemas/onboarding-state.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          status: 'complete',
          current_phase: 'summary',
          completed_phases: ['identity', 'services', 'tenants', 'tutorial', 'summary'],
          created_at: '2026-05-06T00:00:00.000Z',
          updated_at: '2026-05-06T00:10:00.000Z',
          identity: {
            name: 'Sovereign',
            language: 'Japanese',
            interaction_style: 'Concierge',
            primary_domain: 'Software Engineering',
            vision: 'Build a high-fidelity Kyberion environment.',
            agent_id: 'KYBERION-PRIME',
            persona: 'sovereign',
          },
          services: {
            candidates: [
              {
                service_id: 'comfyui',
                status: 'saved',
                connection_kind: 'base_url',
                base_url: 'http://127.0.0.1:8188',
                captured_at: '2026-05-06T00:05:00.000Z',
              },
            ],
          },
          tenants: {
            entries: [
              {
                tenant_slug: 'acme-co',
                tenant_id: 'acme-co',
                display_name: 'Acme Co',
                status: 'active',
                assigned_role: 'strategist',
                purpose: 'First onboarding tenant',
                created_at: '2026-05-06T00:07:00.000Z',
              },
            ],
          },
          tutorial: {
            mode: 'simulate',
            summary: 'Demonstrate the initial Kyberion setup with a safe dry-run.',
            plan_path: 'customer/acme/onboarding/tutorial-plan.md',
          },
        },
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          status: 'draft',
          current_phase: 'invalid-phase',
          completed_phases: [],
          created_at: '2026-05-06T00:00:00.000Z',
          updated_at: '2026-05-06T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'mission-orchestration-scenario-pack',
      schemaPath: 'knowledge/product/schemas/mission-orchestration-scenario-pack.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-orchestration-scenario-pack.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
        },
      ],
    },
  ];

  const policyCheckDeps = {
    workPolicy,
    surfacePolicy,
    surfaceProviderManifests,
    promotedPattern,
    promotedSop,
    promotedHint,
    promotedTemplate,
    additionalGovernanceChecks,
  };

  return [
    ...createContractSchemaChecksPart1(),
    ...createContractSchemaChecksPart2(),
    ...createContractSchemaChecksPart3(),
    ...createPolicyAndManifestChecks(policyCheckDeps),
  ];
}

function main() {
  const ajv = createAjv();
  addFormats(ajv);
  const ajv2020 = createAjv2020({ validateSchema: false });
  addFormats(ajv2020);
  const violations: string[] = [];
  const legacySchemaRoot = pathResolver.rootResolve('schemas');
  if (
    safeExistsSync(legacySchemaRoot) &&
    safeReaddir(legacySchemaRoot).some((entry) => entry.endsWith('.json'))
  ) {
    violations.push(
      'schema-root: schemas/ is a retired compatibility path; place every JSON schema under knowledge/product/schemas/'
    );
  }
  const unmanagedGoldenScenarioCatalogs = findUnmanagedGoldenScenarioCatalogs();
  for (const catalogPath of unmanagedGoldenScenarioCatalogs) {
    violations.push(
      `golden-scenario-catalog: unmanaged deterministic catalog must be migrated into mission-orchestration-scenario-pack.json or mission-workflow-catalog.json: ${catalogPath}`
    );
  }

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
    pathResolver.rootResolve('knowledge/product/schemas/a2ui-message.schema.json')
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
