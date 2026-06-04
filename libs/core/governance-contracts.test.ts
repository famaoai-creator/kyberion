import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { loadActuatorManifestCatalog } from './index.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const GOLDEN_SCENARIO_CATALOG_ALLOWLIST = [
  'mission-orchestration-scenario-pack.json',
  'mission-workflow-catalog.json',
];

type GovernanceSchemaCase = {
  name: string;
  schemaPath: string;
  dataPath: string;
  invalidPayload: unknown;
};

function readPayloadsFromDir(relativeDir: string): unknown[] {
  const dir = path.resolve(process.cwd(), relativeDir);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => JSON.parse(safeReadFile(path.join(dir, entry), { encoding: 'utf8' }) as string));
}

const CASES: GovernanceSchemaCase[] = [
  {
    name: 'intent-policy',
    schemaPath: 'knowledge/product/schemas/intent-policy.schema.json',
    dataPath: 'knowledge/product/governance/intent-policy.json',
    invalidPayload: {
      version: '1.0.0',
      delivery: { rules: [] },
    },
  },
  {
    name: 'active-surfaces',
    schemaPath: 'knowledge/product/schemas/runtime-surface-manifest.schema.json',
    dataPath: 'knowledge/product/governance/active-surfaces.json',
    invalidPayload: { version: 1 },
  },
  {
    name: 'model-registry',
    schemaPath: 'knowledge/product/schemas/model-registry.schema.json',
    dataPath: 'knowledge/product/governance/model-registry.json',
    invalidPayload: {
      version: '1.0.0',
      default_model_id: 'openai:gpt-5.4',
    },
  },
  {
    name: 'model-adaptation-policy',
    schemaPath: 'knowledge/product/schemas/model-adaptation-policy.schema.json',
    dataPath: 'knowledge/product/governance/model-adaptation-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'harness-capability-registry',
    schemaPath: 'knowledge/product/schemas/harness-capability-registry.schema.json',
    dataPath: 'knowledge/product/governance/harness-capability-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'capability-bundle-registry',
    schemaPath: 'knowledge/product/schemas/capability-bundle-registry.schema.json',
    dataPath: 'knowledge/product/governance/capability-bundle-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'intent-execution-profile-registry',
    schemaPath: 'knowledge/product/schemas/intent-execution-profile-registry.schema.json',
    dataPath: 'knowledge/product/governance/intent-execution-profile-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'execution-receipt-policy',
    schemaPath: 'knowledge/product/schemas/execution-receipt-policy.schema.json',
    dataPath: 'knowledge/product/governance/execution-receipt-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-profile-registry',
    schemaPath: 'knowledge/product/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/product/governance/voice-profile-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-profile-directory',
    schemaPath: 'knowledge/product/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/product/governance/voice-profiles/operator-en-default.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-runtime-policy',
    schemaPath: 'knowledge/product/schemas/voice-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/voice-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-engine-registry',
    schemaPath: 'knowledge/product/schemas/voice-engine-registry.schema.json',
    dataPath: 'knowledge/product/governance/voice-engine-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'tool-runtime-policy',
    schemaPath: 'knowledge/product/schemas/tool-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/tool-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'tool-runtime-registry',
    schemaPath: 'knowledge/product/schemas/tool-runtime-registry.schema.json',
    dataPath: 'knowledge/product/governance/tool-runtime-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'service-runtime-policy',
    schemaPath: 'knowledge/product/schemas/service-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/service-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'service-runtime-registry',
    schemaPath: 'knowledge/product/schemas/service-runtime-registry.schema.json',
    dataPath: 'knowledge/product/governance/service-runtime-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-sample-ingestion-policy',
    schemaPath: 'knowledge/product/schemas/voice-sample-ingestion-policy.schema.json',
    dataPath: 'knowledge/product/governance/voice-sample-ingestion-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'video-composition-template-registry',
    schemaPath: 'knowledge/product/schemas/video-composition-template-registry.schema.json',
    dataPath: 'knowledge/product/governance/video-composition-template-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'video-render-runtime-policy',
    schemaPath: 'knowledge/product/schemas/video-render-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/video-render-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-classification-policy',
    schemaPath: 'knowledge/product/schemas/mission-classification-policy.schema.json',
    dataPath: 'knowledge/product/governance/mission-classification-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'authority-role-index',
    schemaPath: 'knowledge/product/schemas/authority-role-index.schema.json',
    dataPath: 'knowledge/product/governance/authority-role-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'authority-role-directory',
    schemaPath: 'knowledge/product/schemas/authority-role.schema.json',
    dataPath: 'knowledge/product/governance/authority-roles/mission_controller.json',
    invalidPayload: {
      description: 'Mission lifecycle authority with mission state and observability write access.',
    },
  },
  {
    name: 'team-role-index',
    schemaPath: 'knowledge/product/schemas/team-role-index.schema.json',
    dataPath: 'knowledge/product/orchestration/team-role-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'team-role-directory',
    schemaPath: 'knowledge/product/schemas/team-role.schema.json',
    dataPath: 'knowledge/product/orchestration/team-roles/owner.json',
    invalidPayload: {
      description: 'Mission owner with final accountability, checkpoint, verify, and finish authority.',
    },
  },
  {
    name: 'agent-profile-index',
    schemaPath: 'knowledge/product/schemas/agent-profile-index.schema.json',
    dataPath: 'knowledge/product/orchestration/agent-profile-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'organization-profile',
    schemaPath: 'knowledge/product/schemas/organization-profile.schema.json',
    dataPath: 'knowledge/product/governance/organization-profile.json',
    invalidPayload: {
      version: '1.0.0',
      organization_id: 'default',
    },
  },
  {
    name: 'organization-team-template-catalog',
    schemaPath: 'knowledge/product/schemas/organization-team-template-catalog.schema.json',
    dataPath: 'knowledge/product/governance/organization-team-template-catalogs/demo-org.json',
    invalidPayload: {
      version: '1.0.0',
      organization_id: 'demo-org',
    },
  },
  {
    name: 'organization-team-template-catalog-ops',
    schemaPath: 'knowledge/product/schemas/organization-team-template-catalog.schema.json',
    dataPath: 'knowledge/product/governance/organization-team-template-catalogs/ops-org.json',
    invalidPayload: {
      version: '1.0.0',
      organization_id: 'ops-org',
    },
  },
  {
    name: 'mission-workflow-catalog',
    schemaPath: 'knowledge/product/schemas/mission-workflow-catalog.schema.json',
    dataPath: 'knowledge/product/governance/mission-workflow-catalog.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-review-gate-registry',
    schemaPath: 'knowledge/product/schemas/mission-review-gate-registry.schema.json',
    dataPath: 'knowledge/product/governance/mission-review-gate-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'path-scope-policy',
    schemaPath: 'knowledge/product/schemas/path-scope-policy.schema.json',
    dataPath: 'knowledge/product/governance/path-scope-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-orchestration-scenario-pack',
    schemaPath: 'knowledge/product/schemas/mission-orchestration-scenario-pack.schema.json',
    dataPath: 'knowledge/product/governance/mission-orchestration-scenario-pack.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'operator-learning-scenario-pack',
    schemaPath: 'knowledge/product/schemas/operator-learning-scenario-pack.schema.json',
    dataPath: 'knowledge/product/governance/operator-learning-scenario-pack.json',
    invalidPayload: {
      version: '1.0.0',
      scenarios: [],
    },
  },
  {
    name: 'operator-learning-dispatch-registry',
    schemaPath: 'knowledge/product/schemas/operator-learning-dispatch-registry.schema.json',
    dataPath: 'knowledge/product/governance/operator-learning-dispatch-registry.json',
    invalidPayload: {
      version: '1.0.0',
      rules: [],
    },
  },
  {
    name: 'presentation-preference-registry',
    schemaPath: 'knowledge/product/schemas/presentation-preference-registry.schema.json',
    dataPath: 'knowledge/product/governance/presentation-preference-registry.json',
    invalidPayload: {
      version: '1.0.0',
      default_profile_id: 'business-deck-default',
      profiles: [],
    },
  },
  {
    name: 'surface-query-overlay-catalog',
    schemaPath: 'knowledge/product/schemas/surface-query-overlay-catalog.schema.json',
    dataPath: 'knowledge/product/governance/surface-query-overlay-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      base_config_path: 'product/presence/surface-query-providers.json',
      overlays: [{ id: 'missing-path', kind: 'role' }],
    },
  },
  {
    name: 'surface-provider-manifest-catalog',
    schemaPath: 'knowledge/product/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/product/governance/surface-provider-manifest-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      entries: [{ id: 'slack', channel: 'slack' }],
    },
  },
  {
    name: 'surface-provider-manifest-catalog-directory',
    schemaPath: 'knowledge/product/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/product/governance/surface-provider-manifest-catalogs/slack.json',
    invalidPayload: {
      version: '1.0.0',
      entries: [{ id: 'slack', channel: 'slack' }],
    },
  },
  {
    name: 'service-endpoints',
    schemaPath: 'knowledge/product/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/product/orchestration/service-endpoints.json',
    invalidPayload: {
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        broken: {},
      },
    },
  },
  {
    name: 'service-endpoints-directory',
    schemaPath: 'knowledge/product/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/product/orchestration/service-endpoints/slack.json',
    invalidPayload: {
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        slack: {},
      },
    },
  },
    {
      name: 'service-presets-directory',
      schemaPath: 'knowledge/product/schemas/service-presets.schema.json',
      dataPath: 'knowledge/product/orchestration/service-presets/slack.json',
      invalidPayload: {
        service_id: 'slack',
      },
    },
  {
    name: 'service-bootstrap-catalog',
    schemaPath: 'knowledge/product/schemas/service-bootstrap-catalog.schema.json',
    dataPath: 'knowledge/product/governance/service-bootstrap-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      entries: [
        {
          id: 'broken',
          service_id: 'slack',
        },
      ],
    },
  },
    {
      name: 'service-onboarding-catalog',
      schemaPath: 'knowledge/product/schemas/service-onboarding-catalog.schema.json',
      dataPath: 'knowledge/product/governance/service-onboarding-catalog.json',
      invalidPayload: {
        version: '1.0.0',
        services: [{ service_id: 'comfyui' }],
      },
    },
    {
      name: 'work-coordination-import-catalog',
      schemaPath: 'knowledge/product/schemas/work-coordination-import-catalog.schema.json',
      dataPath: 'knowledge/product/governance/work-coordination-import-catalog.json',
      invalidPayload: {
        version: '1.0.0',
        imports: [{ id: 'broken', command: 'import-github-issue-file' }],
      },
    },
    {
      name: 'service-authority-map',
      schemaPath: 'knowledge/product/schemas/service-authority-map.schema.json',
      dataPath: 'knowledge/product/governance/service-authority-map.json',
      invalidPayload: {
        version: '1.0.0',
        services: [{ id: 'broken', service_id: 'github' }],
      },
    },
    {
      name: 'actuator-dependency-bundles',
      schemaPath: 'knowledge/product/schemas/actuator-dependency-bundles.schema.json',
      dataPath: 'knowledge/product/governance/actuator-dependency-bundles.json',
      invalidPayload: {
        version: '1.0.0',
        bundles: [{ id: 'broken', actuator: 'voice' }],
      },
    },
    {
      name: 'skill-install-package-map',
      schemaPath: 'knowledge/product/schemas/skill-install-package-map.schema.json',
      dataPath: 'knowledge/product/governance/skill-install-package-map.json',
      invalidPayload: {
        version: '1.0.0',
        entries: [{ id: 'broken', patterns: ['whisper'] }],
      },
    },
    {
      name: 'surface-coordination-role-map',
      schemaPath: 'knowledge/product/schemas/surface-coordination-role-map.schema.json',
      dataPath: 'knowledge/product/governance/surface-coordination-role-map.json',
      invalidPayload: {
        version: '1.0.0',
        entries: [{ surface: 'slack' }],
      },
    },
    {
      name: 'voice-task-profile-catalog',
      schemaPath: 'knowledge/product/schemas/voice-task-profile-catalog.schema.json',
      dataPath: 'knowledge/product/governance/voice-task-profile-catalog.json',
      invalidPayload: {
        version: '1.0.0',
        profiles: [{ id: 'broken', task_type: 'presentation_deck' }],
      },
    },
    {
      name: 'media-tone-style-map',
      schemaPath: 'knowledge/product/schemas/media-tone-style-map.schema.json',
      dataPath: 'knowledge/product/governance/media-tone-style-map.json',
      invalidPayload: {
        version: '1.0.0',
        tones: [{ tone: 'success' }],
      },
    },
    {
      name: 'media-drawio-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-policy.json',
      invalidPayload: {
        version: '1.0.0',
        boundary_palettes: [{ boundary: 'account', fill: '#fff' }],
      },
    },
    {
      name: 'media-drawio-boundary-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-boundary-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-boundary-policy.json',
      invalidPayload: {
        version: '1.0.0',
        palette_overrides: [{ boundary: 'lane', tier: 'web', fill: '#fff' }],
      },
    },
    {
      name: 'media-drawio-tier-order',
      schemaPath: 'knowledge/product/schemas/media-drawio-tier-order.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-tier-order.json',
      invalidPayload: {
        version: '1.0.0',
        tier_order: [],
      },
    },
    {
      name: 'media-drawio-sort-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-sort-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-sort-policy.json',
      invalidPayload: {
        version: '1.0.0',
        group_order: [],
        type_order: ['aws_provider'],
      },
    },
    {
      name: 'media-drawio-security-group-order',
      schemaPath: 'knowledge/product/schemas/media-drawio-security-group-order.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-security-group-order.json',
      invalidPayload: {
        version: '1.0.0',
        relation_prefix: '',
      },
    },
    {
      name: 'document-inference-policy',
      schemaPath: 'knowledge/product/schemas/document-inference-policy.schema.json',
      dataPath: 'knowledge/product/governance/document-inference-policy.json',
      invalidPayload: {
        version: '1.0.0',
        type_rules: [{ document_type: 'report' }],
        profile_rules: [{ document_type: 'report', profile_ids: ['summary-report'] }],
      },
    },
    {
      name: 'document-contents-policy',
      schemaPath: 'knowledge/product/schemas/document-contents-policy.schema.json',
      dataPath: 'knowledge/product/governance/document-contents-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title_by_locale: { ja: '目次' },
      },
    },
    {
      name: 'document-outline-label-policy',
      schemaPath: 'knowledge/product/schemas/document-outline-label-policy.schema.json',
      dataPath: 'knowledge/product/governance/document-outline-label-policy.json',
      invalidPayload: {
        version: '1.0.0',
        report_summary_title: 'Summary',
      },
    },
    {
      name: 'promoted-report-template-policy',
      schemaPath: 'knowledge/product/schemas/promoted-report-template-policy.schema.json',
      dataPath: 'knowledge/product/governance/promoted-report-template-policy.json',
      invalidPayload: {
        version: '1.0.0',
        template_sections: [],
      },
    },
    {
      name: 'onboarding-summary-policy',
      schemaPath: 'knowledge/product/schemas/onboarding-summary-policy.schema.json',
      dataPath: 'knowledge/product/governance/onboarding-summary-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title: 'Kyberion Onboarding Summary',
      },
    },
    {
      name: 'onboarding-flow-policy',
      schemaPath: 'knowledge/product/schemas/onboarding-flow-policy.schema.json',
      dataPath: 'knowledge/product/governance/onboarding-flow-policy.json',
      invalidPayload: {
        version: '1.0.0',
        phase_titles: {
          identity: 'Identity & Purpose',
        },
      },
    },
    {
      name: 'mission-distill-markdown-policy',
      schemaPath: 'knowledge/product/schemas/mission-distill-markdown-policy.schema.json',
      dataPath: 'knowledge/product/governance/mission-distill-markdown-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title_suffix: 'Completion Summary',
      },
    },
    {
      name: 'mission-ledger-policy',
      schemaPath: 'knowledge/product/schemas/mission-ledger-policy.schema.json',
      dataPath: 'knowledge/product/governance/mission-ledger-policy.json',
      invalidPayload: {
        version: '1.0.0',
        section_title: 'Mission Ledger',
      },
    },
    {
      name: 'provider-cli-capability-report-policy',
      schemaPath: 'knowledge/product/schemas/provider-cli-capability-report-policy.schema.json',
      dataPath: 'knowledge/product/governance/provider-cli-capability-report-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title: 'Provider CLI Capability Report',
      },
    },
    {
      name: 'mission-journal-policy',
      schemaPath: 'knowledge/product/schemas/mission-journal-policy.schema.json',
      dataPath: 'knowledge/product/governance/mission-journal-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title: 'Mission Journal: Ecosystem Evolution',
      },
    },
    {
      name: 'pilot-strategy-policy',
      schemaPath: 'knowledge/product/schemas/pilot-strategy-policy.schema.json',
      dataPath: 'knowledge/product/governance/pilot-strategy-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title: 'Kyberion AI Consulting: Go-to-Market Strategy',
      },
    },
    {
      name: 'production-evidence-summary-policy',
      schemaPath: 'knowledge/product/schemas/production-evidence-summary-policy.schema.json',
      dataPath: 'knowledge/product/governance/production-evidence-summary-policy.json',
      invalidPayload: {
        version: '1.0.0',
        title_prefix: 'production evidence',
      },
    },
    {
      name: 'changelog-policy',
      schemaPath: 'knowledge/product/schemas/changelog-policy.schema.json',
      dataPath: 'knowledge/product/governance/changelog-policy.json',
      invalidPayload: {
        version: '1.0.0',
        breaking_changes_title: '⚠ BREAKING CHANGES',
      },
    },
    {
      name: 'spreadsheet-style-policy',
      schemaPath: 'knowledge/product/schemas/spreadsheet-style-policy.schema.json',
      dataPath: 'knowledge/product/governance/spreadsheet-style-policy.json',
      invalidPayload: {
        version: '1.0.0',
        role_indices: {},
      },
    },
    {
      name: 'legacy-media-ops',
      schemaPath: 'knowledge/product/schemas/legacy-media-ops.schema.json',
      dataPath: 'knowledge/product/governance/legacy-media-ops.json',
      invalidPayload: {
        version: '1.0.0',
        ops: [],
      },
    },
    {
      name: 'media-drawio-edge-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-edge-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-drawio-edge-policy.json',
      invalidPayload: {
        version: '1.0.0',
        edge_labels: [{ label: 'uses' }],
      },
    },
    {
      name: 'media-aws-icon-rules',
      schemaPath: 'knowledge/product/schemas/media-aws-icon-rules.schema.json',
      dataPath: 'knowledge/product/governance/media-aws-icon-rules.json',
      invalidPayload: {
        version: '1.0.0',
        rules: [{ match_type: 'contains', match_value: 'cloudwatch' }],
      },
    },
    {
      name: 'media-semantic-map',
      schemaPath: 'knowledge/product/schemas/media-semantic-map.schema.json',
      dataPath: 'knowledge/product/governance/media-semantic-map.json',
      invalidPayload: {
        version: '1.0.0',
        rules: [{ semantic_type: 'hero' }],
      },
    },
    {
      name: 'media-style-policy',
      schemaPath: 'knowledge/product/schemas/media-style-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-style-policy.json',
      invalidPayload: {
        version: '1.0.0',
        signal_tone_ranks: { danger: 0 },
      },
    },
    {
      name: 'media-signal-entry-policy',
      schemaPath: 'knowledge/product/schemas/media-signal-entry-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-signal-entry-policy.json',
      invalidPayload: {
        version: '1.0.0',
        entry_types: [{ source_key: 'signals', signal_type: 'signal' }],
      },
    },
    {
      name: 'tracker-sheet-policy',
      schemaPath: 'knowledge/product/schemas/tracker-sheet-policy.schema.json',
      dataPath: 'knowledge/product/governance/tracker-sheet-policy.json',
      invalidPayload: {
        version: '1.0.0',
        sheet_titles: { overview: 'Overview' },
      },
    },
    {
      name: 'media-theme-role-policy',
      schemaPath: 'knowledge/product/schemas/media-theme-role-policy.schema.json',
      dataPath: 'knowledge/product/governance/media-theme-role-policy.json',
      invalidPayload: {
        version: '1.0.0',
        theme_color_roles: { accent: 'accent' },
      },
    },
    {
      name: 'reasoning-backend-policy',
      schemaPath: 'knowledge/product/schemas/reasoning-backend-policy.schema.json',
      dataPath: 'knowledge/product/governance/reasoning-backend-policy.json',
      invalidPayload: {
        version: '1.0.0',
        allowed_modes: [],
      },
    },
    {
      name: 'specialist-catalog',
      schemaPath: 'knowledge/product/schemas/specialist-catalog.schema.json',
      dataPath: 'knowledge/product/orchestration/specialist-catalog.json',
      invalidPayload: {
      version: '1.0.0',
      specialists: {
        broken: {},
      },
    },
  },
  {
    name: 'specialist-catalog-directory',
    schemaPath: 'knowledge/product/schemas/specialist-catalog.schema.json',
    dataPath: 'knowledge/product/orchestration/specialists/document-specialist.json',
    invalidPayload: {
      version: '1.0.0',
      specialists: {
        broken: {},
      },
    },
  },
  {
    name: 'tool-actuator-routing-policy',
    schemaPath: 'knowledge/product/schemas/tool-actuator-routing-policy.schema.json',
    dataPath: 'knowledge/product/governance/tool-actuator-routing-policy.json',
    invalidPayload: {
      version: '1.0.0',
      defaults: { fallback_actuator: 'orchestrator-actuator' },
      tool_routes: [],
    },
  },
];

describe('governance contracts', () => {
  for (const testCase of CASES) {
    it(`accepts ${testCase.name}`, () => {
      const root = process.cwd();
      const ajv = new AjvCtor({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(root, testCase.schemaPath));
      const payload = JSON.parse(
        safeReadFile(path.resolve(root, testCase.dataPath), { encoding: 'utf8' }) as string,
      );

      expect(validate(payload)).toBe(true);
    });

    it(`rejects invalid ${testCase.name} payloads`, () => {
      const root = process.cwd();
      const ajv = new AjvCtor({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(root, testCase.schemaPath));

      expect(validate(testCase.invalidPayload)).toBe(false);
    });
  }

  it('keeps deterministic golden scenarios in the canonical schema-managed catalogs', () => {
    const governanceDir = path.resolve(process.cwd(), 'knowledge/product/governance');
    const unmanagedCatalogs = safeReaddir(governanceDir)
      .filter((entry) => entry.endsWith('.json'))
      .filter((entry) => {
        const isGoldenScenarioCatalog =
          entry.includes('deterministic') ||
          entry.includes('golden-scenario') ||
          entry.includes('scenario-catalog') ||
          entry.includes('workflow-catalog');
        return isGoldenScenarioCatalog && !GOLDEN_SCENARIO_CATALOG_ALLOWLIST.includes(entry);
      });

    expect(unmanagedCatalogs).toEqual([]);

    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/mission-orchestration-scenario-pack.schema.json'),
    );
    expect(
      validate({
        version: '1.0.0',
        scenarios: [
          {
            scenario_id: 'failure-schema-mismatched-golden-scenario',
            scenario_class: 'golden',
            mission_class: 'operations_and_release',
            delivery_shape: 'single_artifact',
            workflow_pattern: 'stage_gated_delivery',
            prompt: 'schema-mismatched catalog fixture',
          },
        ],
      }),
    ).toBe(false);
  });

  it('keeps the canonical voice profile and surface provider directories aligned with their snapshots', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const voiceSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/voice-profile-registry.schema.json'),
    );
    const voiceSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/governance/voice-profile-registry.json'), { encoding: 'utf8' }) as string,
    );
    const voiceDirPayloads = readPayloadsFromDir('knowledge/product/governance/voice-profiles');
    expect(voiceDirPayloads.length).toBeGreaterThan(0);
    for (const payload of voiceDirPayloads) {
      expect(voiceSchema(payload)).toBe(true);
    }
    expect(
      voiceDirPayloads.map((payload) => (payload as { profiles?: Array<{ profile_id?: string }> }).profiles?.[0]?.profile_id).sort(),
    ).toEqual((voiceSnapshot.profiles || []).map((profile: { profile_id?: string }) => profile.profile_id).sort());

    const providerSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/surface-provider-manifest-catalog.schema.json'),
    );
    const providerSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/governance/surface-provider-manifest-catalog.json'), { encoding: 'utf8' }) as string,
    );
    const providerDirPayloads = readPayloadsFromDir('knowledge/product/governance/surface-provider-manifest-catalogs');
    expect(providerDirPayloads.length).toBeGreaterThan(0);
    for (const payload of providerDirPayloads) {
      expect(providerSchema(payload)).toBe(true);
    }
    expect(
      providerDirPayloads.map((payload) => (payload as { entries?: Array<{ id?: string }> }).entries?.[0]?.id).sort(),
    ).toEqual((providerSnapshot.entries || []).map((entry: { id?: string }) => entry.id).sort());
  });

  it('keeps the canonical authority role directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const authoritySchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/authority-role.schema.json'),
    );
    const authoritySnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/governance/authority-role-index.json'), { encoding: 'utf8' }) as string,
    ) as { authority_roles?: Record<string, unknown> };
    const authorityDirPayloads = readPayloadsFromDir('knowledge/product/governance/authority-roles');
    expect(authorityDirPayloads.length).toBeGreaterThan(0);
    for (const payload of authorityDirPayloads) {
      expect(authoritySchema(payload)).toBe(true);
    }
    expect(
      authorityDirPayloads.map((payload) => (payload as { role?: string }).role).sort(),
    ).toEqual(Object.keys(authoritySnapshot.authority_roles || {}).sort());
  });

  it('keeps the canonical service endpoints directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const endpointSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/service-endpoints.schema.json'),
    );
    const endpointSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/orchestration/service-endpoints.json'), { encoding: 'utf8' }) as string,
    ) as { default_pattern?: string; services?: Record<string, unknown> };
    const endpointDirPayloads = readPayloadsFromDir('knowledge/product/orchestration/service-endpoints');
    expect(endpointDirPayloads.length).toBeGreaterThan(0);
    for (const payload of endpointDirPayloads) {
      expect(endpointSchema(payload)).toBe(true);
    }
    expect(
      endpointDirPayloads.map((payload) => Object.keys((payload as { services?: Record<string, unknown> }).services || {})[0]).sort(),
    ).toEqual(Object.keys(endpointSnapshot.services || {}).sort());
  });

  it('keeps the canonical service presets directory valid', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const presetSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/service-presets.schema.json'),
    );
    const presetDirPayloads = readPayloadsFromDir('knowledge/product/orchestration/service-presets');
    expect(presetDirPayloads.length).toBeGreaterThan(0);
    for (const payload of presetDirPayloads) {
      expect(presetSchema(payload)).toBe(true);
    }
    expect(
      presetDirPayloads.map((payload) => (payload as { service_id?: string }).service_id).sort(),
    ).toContain('slack');
  });

  it('keeps the canonical specialist catalog directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const specialistSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/specialist-catalog.schema.json'),
    );
    const specialistSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/orchestration/specialist-catalog.json'), { encoding: 'utf8' }) as string,
    ) as { version?: string; specialists?: Record<string, unknown> };
    const specialistDirPayloads = readPayloadsFromDir('knowledge/product/orchestration/specialists');
    expect(specialistDirPayloads.length).toBeGreaterThan(0);
    for (const payload of specialistDirPayloads) {
      expect(specialistSchema(payload)).toBe(true);
    }
    expect(
      specialistDirPayloads.map((payload) => Object.keys((payload as { specialists?: Record<string, unknown> }).specialists || {})[0]).sort(),
    ).toEqual(Object.keys(specialistSnapshot.specialists || {}).sort());
  });

  it('keeps the canonical voice engine directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const engineSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/voice-engine-registry.schema.json'),
    );
    const engineSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/governance/voice-engine-registry.json'), { encoding: 'utf8' }) as string,
    ) as { engines?: Array<{ engine_id?: string }> };
    const engineDirPayloads = readPayloadsFromDir('knowledge/product/governance/voice-engines');
    expect(engineDirPayloads.length).toBeGreaterThan(0);
    for (const payload of engineDirPayloads) {
      expect(engineSchema(payload)).toBe(true);
    }
    expect(
      engineDirPayloads.map((payload) => (payload as { engines?: Array<{ engine_id?: string }> }).engines?.[0]?.engine_id).sort(),
    ).toEqual((engineSnapshot.engines || []).map((entry: { engine_id?: string }) => entry.engine_id).sort());
  });

  it('keeps the canonical actuator manifests aligned with the runtime snapshot', () => {
    const normalizeActuatorEntry = ({
      manifest_path: _manifestPath,
      entrypoint: _entrypoint,
      capability_count: _capabilityCount,
      contract_schema: _contractSchema,
      ...entry
    }: Record<string, unknown>) => entry;
    const catalog = loadActuatorManifestCatalog().map(normalizeActuatorEntry);
    const snapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/product/orchestration/global_actuator_index.json'), { encoding: 'utf8' }) as string,
    ) as { actuators?: Array<Record<string, unknown>> };

    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog).toEqual((snapshot.actuators || []).map(normalizeActuatorEntry));
  });
});
