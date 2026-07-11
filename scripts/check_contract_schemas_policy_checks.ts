/**
 * check_contract_schemas_policy_checks.ts — IP-10 slice: the policy /
 * manifest / catalog contract checks extracted from check_contract_schemas
 * (entries 81–126 of the original array). Same pattern as the existing
 * _shared / _evidence_checks / _service_checks extractions.
 */

import { createDistillCandidateRecord, createTaskSession } from '@agent/core';
import {
  ContractCheck,
  readGovernanceJson,
  readSpecialistPayloads,
  readSurfaceProviderCatalogPayloads,
} from './check_contract_schemas_shared.js';

export interface PolicyCheckDeps {
  workPolicy: any;
  surfacePolicy: any;
  surfaceProviderManifests: any;
  promotedPattern: any;
  promotedSop: any;
  promotedHint: any;
  promotedTemplate: any;
  additionalGovernanceChecks: ContractCheck[];
}

// Fixtures from the parent's preamble arrive via deps; the parent stays the
// single place that builds them.
export function createPolicyAndManifestChecks(deps: PolicyCheckDeps): ContractCheck[] {
  const {
    workPolicy,
    surfacePolicy,
    surfaceProviderManifests,
    promotedPattern,
    promotedSop,
    promotedHint,
    promotedTemplate,
    additionalGovernanceChecks,
  } = deps;
  return [
    {
      id: 'document-inference-policy',
      schemaPath: 'knowledge/product/schemas/document-inference-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/document-inference-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          type_rules: [{ document_type: 'report' }],
          profile_rules: [{ document_type: 'report', profile_ids: ['summary-report'] }],
        },
      ],
    },
    {
      id: 'document-contents-policy',
      schemaPath: 'knowledge/product/schemas/document-contents-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/document-contents-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title_by_locale: { ja: '目次' },
        },
      ],
    },
    {
      id: 'document-outline-label-policy',
      schemaPath: 'knowledge/product/schemas/document-outline-label-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/document-outline-label-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          report_summary_title: 'Summary',
        },
      ],
    },
    {
      id: 'promoted-report-template-policy',
      schemaPath: 'knowledge/product/schemas/promoted-report-template-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/promoted-report-template-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          template_sections: [],
        },
      ],
    },
    {
      id: 'onboarding-summary-policy',
      schemaPath: 'knowledge/product/schemas/onboarding-summary-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/onboarding-summary-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title: 'Kyberion Onboarding Summary',
        },
      ],
    },
    {
      id: 'onboarding-flow-policy',
      schemaPath: 'knowledge/product/schemas/onboarding-flow-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/onboarding-flow-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          phase_titles: {
            identity: 'Identity & Purpose',
          },
        },
      ],
    },
    {
      id: 'mission-distill-markdown-policy',
      schemaPath: 'knowledge/product/schemas/mission-distill-markdown-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-distill-markdown-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title_suffix: 'Completion Summary',
        },
      ],
    },
    {
      id: 'mission-ledger-policy',
      schemaPath: 'knowledge/product/schemas/mission-ledger-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-ledger-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          section_title: 'Mission Ledger',
        },
      ],
    },
    {
      id: 'provider-cli-capability-report-policy',
      schemaPath: 'knowledge/product/schemas/provider-cli-capability-report-policy.schema.json',
      validPayloads: [
        readGovernanceJson(
          'knowledge/product/governance/provider-cli-capability-report-policy.json'
        ),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title: 'Provider CLI Capability Report',
        },
      ],
    },
    {
      id: 'mission-journal-policy',
      schemaPath: 'knowledge/product/schemas/mission-journal-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/mission-journal-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title: 'Mission Journal: Ecosystem Evolution',
        },
      ],
    },
    {
      id: 'pilot-strategy-policy',
      schemaPath: 'knowledge/product/schemas/pilot-strategy-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/pilot-strategy-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title: 'Kyberion AI Consulting: Go-to-Market Strategy',
        },
      ],
    },
    {
      id: 'production-evidence-summary-policy',
      schemaPath: 'knowledge/product/schemas/production-evidence-summary-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/production-evidence-summary-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          title_prefix: 'production evidence',
        },
      ],
    },
    {
      id: 'changelog-policy',
      schemaPath: 'knowledge/product/schemas/changelog-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/changelog-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          breaking_changes_title: '⚠ BREAKING CHANGES',
        },
      ],
    },
    {
      id: 'spreadsheet-style-policy',
      schemaPath: 'knowledge/product/schemas/spreadsheet-style-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/spreadsheet-style-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          role_indices: {},
        },
      ],
    },
    {
      id: 'legacy-media-ops',
      schemaPath: 'knowledge/product/schemas/legacy-media-ops.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/legacy-media-ops.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          ops: [],
        },
      ],
    },
    {
      id: 'media-drawio-edge-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-edge-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-drawio-edge-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          edge_labels: [{ label: 'uses' }],
        },
      ],
    },
    {
      id: 'media-aws-icon-rules',
      schemaPath: 'knowledge/product/schemas/media-aws-icon-rules.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/media-aws-icon-rules.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          rules: [{ match_type: 'contains', match_value: 'cloudwatch' }],
        },
      ],
    },
    {
      id: 'media-semantic-map',
      schemaPath: 'knowledge/product/schemas/media-semantic-map.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/media-semantic-map.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          rules: [{ semantic_type: 'hero' }],
        },
      ],
    },
    {
      id: 'media-style-policy',
      schemaPath: 'knowledge/product/schemas/media-style-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/media-style-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          signal_tone_ranks: { danger: 0 },
        },
      ],
    },
    {
      id: 'media-signal-entry-policy',
      schemaPath: 'knowledge/product/schemas/media-signal-entry-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-signal-entry-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          entry_types: [{ source_key: 'signals', signal_type: 'signal' }],
        },
      ],
    },
    {
      id: 'tracker-sheet-policy',
      schemaPath: 'knowledge/product/schemas/tracker-sheet-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/tracker-sheet-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          sheet_titles: { overview: 'Overview' },
        },
      ],
    },
    {
      id: 'media-theme-role-policy',
      schemaPath: 'knowledge/product/schemas/media-theme-role-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-theme-role-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          theme_color_roles: { accent: 'accent' },
        },
      ],
    },
    {
      id: 'reasoning-backend-policy',
      schemaPath: 'knowledge/product/schemas/reasoning-backend-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/reasoning-backend-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          allowed_modes: [],
        },
      ],
    },
    {
      id: 'specialist-catalog',
      schemaPath: 'knowledge/product/schemas/specialist-catalog.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          specialists: {
            'document-specialist': {
              label: 'Document Specialist',
              description: 'Creates decks, reports, and structured workbook artifacts.',
              conversation_agent: 'presence-surface-agent',
              team_roles: ['planner', 'implementer', 'reviewer'],
              capabilities: [
                'presentation_deck',
                'report_document',
                'workbook_wbs',
                'artifact_generation',
              ],
            },
          },
        },
        ...readSpecialistPayloads(),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          specialists: {
            broken: {},
          },
        },
      ],
    },
    {
      id: 'actuator-request-archetypes',
      schemaPath: 'knowledge/product/schemas/actuator-request-archetypes.schema.json',
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
      schemaPath: 'knowledge/product/schemas/points-portal-clickout-usecase.schema.json',
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
      schemaPath: 'knowledge/product/schemas/task-session.schema.json',
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
      schemaPath: 'knowledge/product/schemas/task-session-capture-photo.schema.json',
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
      schemaPath: 'knowledge/product/schemas/work-policy.schema.json',
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
      schemaPath: 'knowledge/product/schemas/surface-provider-manifests.schema.json',
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
      id: 'surface-provider-manifest-catalog',
      schemaPath: 'knowledge/product/schemas/surface-provider-manifest-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/surface-provider-manifest-catalog.json'),
        ...readSurfaceProviderCatalogPayloads(),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          entries: [{ id: 'slack', channel: 'slack' }],
        },
      ],
    },
    {
      id: 'surface-policy',
      schemaPath: 'knowledge/product/schemas/surface-policy.schema.json',
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
      schemaPath: 'knowledge/product/schemas/standard-intents.schema.json',
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
      schemaPath: 'knowledge/product/schemas/intent-domain-ontology.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/intent-domain-ontology.json'),
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
      schemaPath: 'knowledge/product/schemas/a2a-task-contract.schema.json',
      validPayloads: [
        {
          intent: 'request_mission_work',
          text: '進捗をまとめて',
          objective: 'team_status_summary',
          acceptance_criteria: ['summarize the mission', 'list open questions'],
          expected_outputs: ['summary', 'open questions'],
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
      schemaPath: 'knowledge/product/schemas/intent-resolution-policy.schema.json',
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
      schemaPath: 'knowledge/product/schemas/task-session-policy.schema.json',
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
      schemaPath: 'knowledge/product/schemas/intent-contract.schema.json',
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
      schemaPath: 'knowledge/product/schemas/agent-routing-decision.schema.json',
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
      schemaPath: 'knowledge/product/schemas/pipeline-adf.schema.json',
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
      schemaPath: 'knowledge/product/schemas/distill-candidate-record.schema.json',
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
      schemaPath: 'knowledge/product/schemas/generated-pattern-record.schema.json',
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
      schemaPath: 'knowledge/product/schemas/generated-sop-record.schema.json',
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
      schemaPath: 'knowledge/product/schemas/generated-knowledge-hint-record.schema.json',
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
      schemaPath: 'knowledge/product/schemas/generated-report-template-record.schema.json',
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
