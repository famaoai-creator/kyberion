import * as path from 'node:path';
import {
  loadActuatorManifestCatalog,
  readModelRegistryDirectory,
  pathResolver,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeStat,
  assertProcessDefinitionRegistry,
} from '@agent/core';
import { compileSchema, readJson as readFoundationJson } from '@agent/core/foundation';
import { fileURLToPath } from 'node:url';
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  validateActuatorCatalogDirectoryConsistency,
  validateAgentProfileDirectoryConsistency,
  validateAuthorityRoleDirectoryConsistency,
  validateServiceEndpointsDirectoryConsistency,
  validateSpecialistCatalogDirectoryConsistency,
  validateSurfaceProviderCatalogDirectoryConsistency,
  validateTeamRoleDirectoryConsistency,
  validateVoiceEngineDirectoryConsistency,
  validateVoiceProfileDirectoryConsistency,
} from './check-governance-directory-consistency.js';
import {
  findMachineAbsolutePathViolations,
  scanProductJsonForPlacementDrift,
} from './check-governance-path-scanners.js';

type GovernanceRuleCheck = {
  id: string;
  schemaPath: string;
  dataPath: string;
};

const GOVERNANCE_DIR = 'knowledge/product/governance';

const CHECKS: GovernanceRuleCheck[] = [
  {
    id: 'intent-policy',
    schemaPath: 'knowledge/product/schemas/intent-policy.schema.json',
    dataPath: 'knowledge/product/governance/intent-policy.json',
  },
  {
    id: 'reasoning-level-policy',
    schemaPath: 'knowledge/product/schemas/reasoning-level-policy.schema.json',
    dataPath: 'knowledge/product/governance/reasoning-level-policy.json',
  },
  {
    id: 'meeting-environment-policy',
    schemaPath: 'knowledge/product/schemas/meeting-environment-policy.schema.json',
    dataPath: 'knowledge/product/governance/meeting-environment-policy.json',
  },
  {
    id: 'intent-resolution-policy',
    schemaPath: 'knowledge/product/schemas/intent-resolution-policy.schema.json',
    dataPath: 'knowledge/product/governance/intent-resolution-policy.json',
  },
  {
    id: 'task-session-policy',
    schemaPath: 'knowledge/product/schemas/task-session-policy.schema.json',
    dataPath: 'knowledge/product/governance/task-session-policy.json',
  },
  {
    id: 'work-policy',
    schemaPath: 'knowledge/product/schemas/work-policy.schema.json',
    dataPath: 'knowledge/product/governance/work-policy.json',
  },
  {
    id: 'surface-policy',
    schemaPath: 'knowledge/product/schemas/surface-policy.schema.json',
    dataPath: 'knowledge/product/governance/surface-policy.json',
  },
  {
    id: 'standard-intents',
    schemaPath: 'knowledge/product/schemas/standard-intents.schema.json',
    dataPath: 'knowledge/product/governance/standard-intents.json',
  },
  {
    id: 'intent-domain-ontology',
    schemaPath: 'knowledge/product/schemas/intent-domain-ontology.schema.json',
    dataPath: 'knowledge/product/governance/intent-domain-ontology.json',
  },
  {
    id: 'intent-contract-memory',
    schemaPath: 'knowledge/product/schemas/intent-contract-memory.schema.json',
    dataPath: 'knowledge/product/governance/intent-contract-memory.json',
  },
  {
    id: 'intent-contract-selection-policy',
    schemaPath: 'knowledge/product/schemas/intent-contract-selection-policy.schema.json',
    dataPath: 'knowledge/product/governance/intent-contract-selection-policy.json',
  },
  {
    id: 'tool-actuator-routing-policy',
    schemaPath: 'knowledge/product/schemas/tool-actuator-routing-policy.schema.json',
    dataPath: 'knowledge/product/governance/tool-actuator-routing-policy.json',
  },
  {
    id: 'active-surfaces',
    schemaPath: 'knowledge/product/schemas/runtime-surface-manifest.schema.json',
    dataPath: 'knowledge/product/governance/active-surfaces.json',
  },
  {
    id: 'surface-provider-manifests',
    schemaPath: 'knowledge/product/schemas/surface-provider-manifests.schema.json',
    dataPath: 'knowledge/product/governance/surface-provider-manifests.json',
  },
  {
    id: 'surface-provider-manifest-catalog',
    schemaPath: 'knowledge/product/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/product/governance/surface-provider-manifest-catalog.json',
  },
  {
    id: 'model-registry',
    schemaPath: 'knowledge/product/schemas/model-registry.schema.json',
    dataPath: 'knowledge/product/governance/model-registry.json',
  },
  {
    id: 'model-adaptation-policy',
    schemaPath: 'knowledge/product/schemas/model-adaptation-policy.schema.json',
    dataPath: 'knowledge/product/governance/model-adaptation-policy.json',
  },
  {
    id: 'harness-capability-registry',
    schemaPath: 'knowledge/product/schemas/harness-capability-registry.schema.json',
    dataPath: 'knowledge/product/governance/harness-capability-registry.json',
  },
  {
    id: 'harness-adapter-registry',
    schemaPath: 'knowledge/product/schemas/harness-adapter-registry.schema.json',
    dataPath: 'knowledge/product/governance/harness-adapter-registry.json',
  },
  {
    id: 'provider-capability-scan-policy',
    schemaPath: 'knowledge/product/schemas/provider-capability-scan-policy.schema.json',
    dataPath: 'knowledge/product/governance/provider-capability-scan-policy.json',
  },
  {
    id: 'capability-lifecycle-procedure',
    schemaPath: 'knowledge/product/schemas/capability-lifecycle-procedure.schema.json',
    dataPath: 'knowledge/product/governance/capability-lifecycle-procedure.json',
  },
  {
    id: 'execution-receipt-policy',
    schemaPath: 'knowledge/product/schemas/execution-receipt-policy.schema.json',
    dataPath: 'knowledge/product/governance/execution-receipt-policy.json',
  },
  {
    id: 'voice-profile-registry',
    schemaPath: 'knowledge/product/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/product/governance/voice-profile-registry.json',
  },
  {
    id: 'voice-runtime-policy',
    schemaPath: 'knowledge/product/schemas/voice-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/voice-runtime-policy.json',
  },
  {
    id: 'voice-engine-registry',
    schemaPath: 'knowledge/product/schemas/voice-engine-registry.schema.json',
    dataPath: 'knowledge/product/governance/voice-engine-registry.json',
  },
  {
    id: 'voice-sample-ingestion-policy',
    schemaPath: 'knowledge/product/schemas/voice-sample-ingestion-policy.schema.json',
    dataPath: 'knowledge/product/governance/voice-sample-ingestion-policy.json',
  },
  {
    id: 'video-composition-template-registry',
    schemaPath: 'knowledge/product/schemas/video-composition-template-registry.schema.json',
    dataPath: 'knowledge/product/governance/video-composition-template-registry.json',
  },
  {
    id: 'video-render-runtime-policy',
    schemaPath: 'knowledge/product/schemas/video-render-runtime-policy.schema.json',
    dataPath: 'knowledge/product/governance/video-render-runtime-policy.json',
  },
  {
    id: 'mission-classification-policy',
    schemaPath: 'knowledge/product/schemas/mission-classification-policy.schema.json',
    dataPath: 'knowledge/product/governance/mission-classification-policy.json',
  },
  {
    id: 'authority-role-index',
    schemaPath: 'knowledge/product/schemas/authority-role-index.schema.json',
    dataPath: 'knowledge/product/governance/authority-role-index.json',
  },
  {
    id: 'team-role-index',
    schemaPath: 'knowledge/product/schemas/team-role-index.schema.json',
    dataPath: 'knowledge/product/orchestration/team-role-index.json',
  },
  {
    id: 'agent-profile-index',
    schemaPath: 'knowledge/product/schemas/agent-profile-index.schema.json',
    dataPath: 'knowledge/product/orchestration/agent-profile-index.json',
  },
  {
    id: 'mission-workflow-catalog',
    schemaPath: 'knowledge/product/schemas/mission-workflow-catalog.schema.json',
    dataPath: 'knowledge/product/governance/mission-workflow-catalog.json',
  },
  {
    id: 'mission-review-gate-registry',
    schemaPath: 'knowledge/product/schemas/mission-review-gate-registry.schema.json',
    dataPath: 'knowledge/product/governance/mission-review-gate-registry.json',
  },
  {
    id: 'path-scope-policy',
    schemaPath: 'knowledge/product/schemas/path-scope-policy.schema.json',
    dataPath: 'knowledge/product/governance/path-scope-policy.json',
  },
  {
    id: 'mission-orchestration-scenario-pack',
    schemaPath: 'knowledge/product/schemas/mission-orchestration-scenario-pack.schema.json',
    dataPath: 'knowledge/product/governance/mission-orchestration-scenario-pack.json',
  },
  {
    id: 'process-definition-registry',
    schemaPath: 'knowledge/product/schemas/process-definition-registry.schema.json',
    dataPath: 'knowledge/product/governance/process-definition-registry.json',
  },
  {
    id: 'mission-process-registry',
    schemaPath: 'knowledge/product/schemas/mission-process-registry.schema.json',
    dataPath: 'knowledge/product/governance/mission-process-registry.json',
  },
  {
    id: 'security-policy',
    schemaPath: 'knowledge/product/schemas/security-policy.schema.json',
    dataPath: 'knowledge/product/governance/security-policy.json',
  },
  {
    id: 'approval-policy',
    schemaPath: 'knowledge/product/schemas/approval-policy.schema.json',
    dataPath: 'knowledge/product/governance/approval-policy.json',
  },
  {
    id: 'spend-policy',
    schemaPath: 'knowledge/product/schemas/spend-policy.schema.json',
    dataPath: 'knowledge/product/governance/spend-policy.json',
  },
  {
    id: 'trust-policy',
    schemaPath: 'knowledge/product/schemas/trust-policy.schema.json',
    dataPath: 'knowledge/product/governance/trust-policy.json',
  },
  {
    id: 'egress-policy',
    schemaPath: 'knowledge/product/schemas/egress-policy.schema.json',
    dataPath: 'knowledge/product/governance/egress-policy.json',
  },
  {
    id: 'shell-command-policy',
    schemaPath: 'knowledge/product/schemas/shell-command-policy.schema.json',
    dataPath: 'knowledge/product/governance/shell-command-policy.json',
  },
  {
    id: 'permission-presets',
    schemaPath: 'knowledge/product/schemas/permission-presets.schema.json',
    dataPath: 'knowledge/product/governance/permission-presets.json',
  },
  {
    id: 'intent-routing-map',
    schemaPath: 'knowledge/product/schemas/intent-routing-map.schema.json',
    dataPath: 'knowledge/product/governance/intent-routing-map.json',
  },
  {
    id: 'error-classifier-rules',
    schemaPath: 'knowledge/product/schemas/error-classifier-rules.schema.json',
    dataPath: 'knowledge/product/governance/error-classifier-rules.json',
  },
  {
    id: 'outcome-catalog',
    schemaPath: 'knowledge/product/schemas/outcome-catalog.schema.json',
    dataPath: 'knowledge/product/governance/outcome-catalog.json',
  },
  {
    id: 'ci-gates',
    schemaPath: 'knowledge/product/schemas/ci-gates.schema.json',
    dataPath: 'knowledge/product/governance/ci-gates.json',
  },
  {
    id: 'media-aws-icon-rules',
    schemaPath: 'knowledge/product/schemas/media-aws-icon-rules.schema.json',
    dataPath: 'knowledge/product/governance/media-aws-icon-rules.json',
  },
  {
    id: 'media-tone-style-map',
    schemaPath: 'knowledge/product/schemas/media-tone-style-map.schema.json',
    dataPath: 'knowledge/product/governance/media-tone-style-map.json',
  },
];

export function findDeterministicCatalogViolations(): string[] {
  const dir = pathResolver.rootResolve(GOVERNANCE_DIR);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => /-deterministic\.json$/i.test(entry))
    .map((entry) => `${GOVERNANCE_DIR}/${entry}`);
}

function readJson<T>(relativePath: string): T {
  return readFoundationJson<T>(pathResolver.rootResolve(relativePath));
}

function validateRuleFile(check: GovernanceRuleCheck, violations: string[]) {
  const data = readJson<Record<string, unknown>>(check.dataPath);
  const validate = compileSchema(check.schemaPath);
  const ok = validate(data);
  if (!ok) {
    for (const error of validate.errors || []) {
      violations.push(
        `${check.id}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`
      );
    }
  }

  if (check.id === 'work-policy') {
    const typed = data as {
      specialist_routing?: { rules?: unknown[]; fallback_specialist_id?: string };
      profile_routing?: {
        defaults?: {
          execution_boundary_profile_id?: string;
          runtime_design_profile_id?: string;
        };
      };
      design_rules?: {
        process_checklist_rules?: unknown[];
        execution_shape_rules?: unknown[];
        intent_label_rules?: unknown[];
      };
    };
    if (!(typed.specialist_routing?.rules || []).length) {
      violations.push('work-policy: specialist_routing.rules must not be empty');
    }
    if (!String(typed.specialist_routing?.fallback_specialist_id || '')) {
      violations.push('work-policy: specialist_routing.fallback_specialist_id must not be empty');
    }
    if (!String(typed.profile_routing?.defaults?.execution_boundary_profile_id || '')) {
      violations.push(
        'work-policy: profile_routing.defaults.execution_boundary_profile_id must not be empty'
      );
    }
    if (!String(typed.profile_routing?.defaults?.runtime_design_profile_id || '')) {
      violations.push(
        'work-policy: profile_routing.defaults.runtime_design_profile_id must not be empty'
      );
    }
    if (!(typed.design_rules?.process_checklist_rules || []).length) {
      violations.push('work-policy: design_rules.process_checklist_rules must not be empty');
    }
    if (!(typed.design_rules?.execution_shape_rules || []).length) {
      violations.push('work-policy: design_rules.execution_shape_rules must not be empty');
    }
    if (!(typed.design_rules?.intent_label_rules || []).length) {
      violations.push('work-policy: design_rules.intent_label_rules must not be empty');
    }
  }

  if (check.id === 'intent-policy') {
    const typed = data as {
      delivery?: { rules?: Array<{ mode?: string }> };
      compiler?: {
        relevant_intent_limit?: number;
        intent_contract_rules?: unknown[];
        work_loop_rules?: unknown[];
      };
    };
    const modes = new Set((typed.delivery?.rules || []).map((rule) => String(rule.mode || '')));
    if (!modes.has('one_shot')) {
      violations.push('intent-policy: at least one one_shot delivery rule is required');
    }
    if (!modes.has('managed_program')) {
      violations.push('intent-policy: at least one managed_program delivery rule is required');
    }
    if ((typed.compiler?.relevant_intent_limit || 0) < 1) {
      violations.push('intent-policy: compiler.relevant_intent_limit must be >= 1');
    }
    if (!(typed.compiler?.intent_contract_rules || []).length) {
      violations.push('intent-policy: compiler.intent_contract_rules must not be empty');
    }
    if (!(typed.compiler?.work_loop_rules || []).length) {
      violations.push('intent-policy: compiler.work_loop_rules must not be empty');
    }
  }

  if (check.id === 'intent-resolution-policy') {
    const typed = data as {
      catalog_scoring?: {
        selected_confidence_threshold?: number;
        catalog_intent_category?: string;
      };
      legacy_candidates?: Array<{ intent_id?: string; patterns?: unknown[] }>;
    };
    if ((typed.catalog_scoring?.selected_confidence_threshold || 0) <= 0) {
      violations.push(
        'intent-resolution-policy: catalog_scoring.selected_confidence_threshold must be > 0'
      );
    }
    if (!String(typed.catalog_scoring?.catalog_intent_category || '')) {
      violations.push(
        'intent-resolution-policy: catalog_scoring.catalog_intent_category must not be empty'
      );
    }
    if (!(typed.legacy_candidates || []).length) {
      violations.push('intent-resolution-policy: legacy_candidates must not be empty');
    }
    for (const candidate of typed.legacy_candidates || []) {
      if (!String(candidate.intent_id || '')) {
        violations.push('intent-resolution-policy: every legacy candidate must define intent_id');
      }
      if (!(candidate.patterns || []).length) {
        violations.push(
          `intent-resolution-policy: ${String(candidate.intent_id || 'unknown')} must define patterns`
        );
      }
    }
  }

  if (check.id === 'task-session-policy') {
    const typed = data as {
      intents?: Array<{
        id?: string;
        task_type?: string;
        goal?: { summary?: string; success_condition?: string };
      }>;
    };
    if (!(typed.intents || []).length) {
      violations.push('task-session-policy: intents must not be empty');
    }
    for (const intent of typed.intents || []) {
      if (!String(intent.id || '')) {
        violations.push('task-session-policy: every intent must define id');
      }
      if (!String(intent.task_type || '')) {
        violations.push(
          `task-session-policy: ${String(intent.id || 'unknown')} must define task_type`
        );
      }
      if (!String(intent.goal?.summary || '')) {
        violations.push(
          `task-session-policy: ${String(intent.id || 'unknown')} must define goal.summary`
        );
      }
      if (!String(intent.goal?.success_condition || '')) {
        violations.push(
          `task-session-policy: ${String(intent.id || 'unknown')} must define goal.success_condition`
        );
      }
    }
  }

  if (check.id === 'mission-classification-policy') {
    const typed = data as {
      stage_progression?: string[];
      mission_class_rules?: unknown[];
      delivery_shape_rules?: unknown[];
      risk_profile_rules?: unknown[];
      stage_rules?: unknown[];
    };
    if (!(typed.stage_progression || []).length) {
      violations.push('mission-classification-policy: stage_progression must not be empty');
    }
    if (!(typed.mission_class_rules || []).length) {
      violations.push('mission-classification-policy: mission_class_rules must not be empty');
    }
    if (!(typed.delivery_shape_rules || []).length) {
      violations.push('mission-classification-policy: delivery_shape_rules must not be empty');
    }
    if (!(typed.risk_profile_rules || []).length) {
      violations.push('mission-classification-policy: risk_profile_rules must not be empty');
    }
    if (!(typed.stage_rules || []).length) {
      violations.push('mission-classification-policy: stage_rules must not be empty');
    }
  }

  if (check.id === 'mission-workflow-catalog') {
    const typed = data as {
      patterns?: Record<string, unknown>;
      templates?: unknown[];
      defaults?: { workflow_id?: string };
    };
    if (!String(typed.defaults?.workflow_id || '')) {
      violations.push('mission-workflow-catalog: defaults.workflow_id must not be empty');
    }
    if (!typed.patterns || !Object.keys(typed.patterns).length) {
      violations.push('mission-workflow-catalog: patterns must not be empty');
    }
    if (!(typed.templates || []).length) {
      violations.push('mission-workflow-catalog: templates must not be empty');
    }
  }

  if (check.id === 'mission-review-gate-registry') {
    const typed = data as {
      defaults?: { review_mode?: string };
      gates?: unknown[];
      mode_rules?: unknown[];
    };
    if (!String(typed.defaults?.review_mode || '')) {
      violations.push('mission-review-gate-registry: defaults.review_mode must not be empty');
    }
    if (!(typed.gates || []).length) {
      violations.push('mission-review-gate-registry: gates must not be empty');
    }
    if (!(typed.mode_rules || []).length) {
      violations.push('mission-review-gate-registry: mode_rules must not be empty');
    }
  }

  if (check.id === 'path-scope-policy') {
    const typed = data as {
      defaults?: { unknown_scope_behavior?: string };
      scope_classes?: Record<string, { allow_prefixes?: unknown[] }>;
    };
    if (!String(typed.defaults?.unknown_scope_behavior || '')) {
      violations.push('path-scope-policy: defaults.unknown_scope_behavior must not be empty');
    }
    const scopeClasses = typed.scope_classes || {};
    if (!Object.keys(scopeClasses).length) {
      violations.push('path-scope-policy: scope_classes must not be empty');
    }
    for (const [scopeClass, config] of Object.entries(scopeClasses)) {
      if (!(config.allow_prefixes || []).length) {
        violations.push(`path-scope-policy: ${scopeClass} must define allow_prefixes`);
      }
    }
  }

  if (check.id === 'mission-orchestration-scenario-pack') {
    const typed = data as {
      scenarios?: Array<{ scenario_id?: string; scenario_class?: string }>;
    };
    if (!(typed.scenarios || []).length) {
      violations.push('mission-orchestration-scenario-pack: scenarios must not be empty');
    }
    const ids = new Set<string>();
    for (const scenario of typed.scenarios || []) {
      const id = String(scenario.scenario_id || '');
      if (!id) {
        violations.push(
          'mission-orchestration-scenario-pack: every scenario must define scenario_id'
        );
        continue;
      }
      if (ids.has(id)) {
        violations.push(`mission-orchestration-scenario-pack: duplicated scenario_id: ${id}`);
      }
      ids.add(id);
      if (!['golden', 'controlled-failure'].includes(String(scenario.scenario_class || ''))) {
        violations.push(`mission-orchestration-scenario-pack: ${id} has invalid scenario_class`);
      }
    }
  }

  if (check.id === 'surface-provider-manifest-catalog') {
    validateSurfaceProviderCatalogDirectoryConsistency(violations);
  }

  if (check.id === 'service-endpoints') {
    validateServiceEndpointsDirectoryConsistency(violations);
  }

  if (check.id === 'voice-engine-registry') {
    validateVoiceEngineDirectoryConsistency(violations);
  }

  if (check.id === 'specialist-catalog') {
    validateSpecialistCatalogDirectoryConsistency(violations);
  }

  if (check.id === 'agent-profile-index') {
    validateAgentProfileDirectoryConsistency(violations);
  }
  if (check.id === 'standard-intents') {
    const typed = data as {
      intents?: Array<{
        id?: string;
        category?: string;
        legacy_category?: string;
        exposed_to_surface?: boolean;
        trigger_keywords?: unknown[];
      }>;
    };
    if (!(typed.intents || []).length) {
      violations.push('standard-intents: intents must not be empty');
    }
    for (const intent of typed.intents || []) {
      if (!String(intent.id || '')) {
        violations.push('standard-intents: every intent must define id');
      }
      if (!String(intent.category || '')) {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define category`);
      }
      if (!String(intent.legacy_category || '')) {
        violations.push(
          `standard-intents: ${String(intent.id || 'unknown')} must define legacy_category`
        );
      }
      if (typeof intent.exposed_to_surface !== 'boolean') {
        violations.push(
          `standard-intents: ${String(intent.id || 'unknown')} must define exposed_to_surface`
        );
      }
      if (!(intent.trigger_keywords || []).length) {
        violations.push(
          `standard-intents: ${String(intent.id || 'unknown')} must define trigger_keywords`
        );
      }
    }
  }

  if (check.id === 'intent-domain-ontology') {
    const typed = data as {
      intents?: Array<{ intent_id?: string; legacy_category?: string; category?: string }>;
    };
    if (!(typed.intents || []).length) {
      violations.push('intent-domain-ontology: intents must not be empty');
    }
    const ids = new Set<string>();
    for (const intent of typed.intents || []) {
      const intentId = String(intent.intent_id || '');
      if (!intentId) {
        violations.push('intent-domain-ontology: every entry must define intent_id');
        continue;
      }
      if (ids.has(intentId)) {
        violations.push(`intent-domain-ontology: duplicate intent_id detected (${intentId})`);
      }
      ids.add(intentId);
      if (!String(intent.legacy_category || '')) {
        violations.push(`intent-domain-ontology: ${intentId} must define legacy_category`);
      }
      if (!String(intent.category || '')) {
        violations.push(`intent-domain-ontology: ${intentId} must define category`);
      }
    }
  }

  if (check.id === 'active-surfaces') {
    const typed = data as { surfaces?: Array<{ id?: string; enabled?: boolean }> };
    if (!(typed.surfaces || []).length) {
      violations.push('active-surfaces: surfaces must not be empty');
    }
    if (!(typed.surfaces || []).some((surface) => surface.enabled !== false)) {
      violations.push('active-surfaces: at least one surface must be enabled');
    }
    const surfacesDir = pathResolver.rootResolve('knowledge/product/governance/surfaces');
    if (safeExistsSync(surfacesDir)) {
      const directorySurfaces: Array<{ id?: string; enabled?: boolean }> = [];
      for (const entry of safeReaddir(surfacesDir)
        .filter((name) => name.endsWith('.json'))
        .sort()) {
        const surfaceManifest = readJson<{
          version?: number;
          surfaces?: Array<{ id?: string; enabled?: boolean }>;
        }>(path.join('knowledge/product/governance/surfaces', entry));
        if (!validate(surfaceManifest)) {
          for (const error of validate.errors || []) {
            violations.push(
              `active-surfaces:${entry}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`
            );
          }
        }
        if (!(surfaceManifest.surfaces || []).length) {
          violations.push(`active-surfaces:${entry}: surfaces must not be empty`);
          continue;
        }
        if ((surfaceManifest.surfaces || []).length !== 1) {
          violations.push(
            `active-surfaces:${entry}: surface manifest files must contain exactly one surface`
          );
          continue;
        }
        const surfaces = surfaceManifest.surfaces || [];
        const surface = surfaces[0];
        const expectedId = entry.replace(/\.json$/i, '');
        if (String(surface.id || '') !== expectedId) {
          violations.push(
            `active-surfaces:${entry}: surface id must match file name (${expectedId})`
          );
        }
        directorySurfaces.push(surface);
      }
      const sortById = (items: Array<{ id?: string }>) =>
        [...items].sort((left, right) =>
          String(left.id || '').localeCompare(String(right.id || ''))
        );
      const snapshotIds = JSON.stringify(sortById(typed.surfaces || []));
      const directoryIds = JSON.stringify(sortById(directorySurfaces));
      if (snapshotIds !== directoryIds) {
        violations.push(
          'active-surfaces: compatibility snapshot must match knowledge/product/governance/surfaces/*.json'
        );
      }
    }
  }

  if (check.id === 'model-registry') {
    const typed = data as {
      default_model_id?: string;
      models?: Array<{ model_id?: string; status?: string }>;
    };
    if (!(typed.models || []).length) {
      violations.push('model-registry: models must not be empty');
      return;
    }
    const modelIds = new Set<string>();
    for (const model of typed.models || []) {
      const modelId = String(model.model_id || '');
      if (!modelId) {
        violations.push('model-registry: every model must define model_id');
        continue;
      }
      if (modelIds.has(modelId)) {
        violations.push(`model-registry: duplicate model_id detected (${modelId})`);
      }
      modelIds.add(modelId);
    }
    if (!typed.default_model_id) {
      violations.push('model-registry: default_model_id must not be empty');
      return;
    }
    const defaultModel = (typed.models || []).find(
      (model) => model.model_id === typed.default_model_id
    );
    if (!defaultModel) {
      violations.push('model-registry: default_model_id must reference an existing model_id');
      return;
    }
    if (defaultModel.status !== 'approved') {
      violations.push('model-registry: default_model_id must point to an approved model');
    }
    if (!(typed.models || []).some((model) => model.status === 'candidate')) {
      violations.push(
        'model-registry: at least one candidate model is required for shadow adaptation'
      );
    }

    const directory = pathResolver.rootResolve('knowledge/product/governance/model-registry');
    const indexPath = path.join(directory, 'index.json');
    if (!safeExistsSync(directory)) {
      violations.push('model-registry: canonical directory is missing');
      return;
    }
    if (!safeExistsSync(indexPath)) {
      violations.push('model-registry: canonical directory index is missing');
      return;
    }

    const directoryData = readModelRegistryDirectory<Record<string, unknown>>(directory);
    if (!directoryData) {
      violations.push('model-registry: canonical directory is missing');
      return;
    }
    const { index, entries } = directoryData;
    const snapshotIds = (typed.models || []).map((model) => String(model.model_id || ''));
    const indexIds = index.model_order;
    if (index.version !== String((data as { version?: string }).version || '')) {
      violations.push('model-registry: directory index version must match the snapshot');
    }
    if (index.default_model_id !== String(typed.default_model_id || '')) {
      violations.push('model-registry: directory index default_model_id must match the snapshot');
    }
    if (JSON.stringify(indexIds) !== JSON.stringify(snapshotIds)) {
      violations.push('model-registry: directory index model_order must match the snapshot');
    }

    const directoryModels = new Map<string, Record<string, unknown>>();
    for (const { file, model } of entries) {
      const modelId = model.model_id as string;
      if (directoryModels.has(modelId)) {
        violations.push(`model-registry/${file}: duplicate model_id ${modelId}`);
        continue;
      }
      const itemValid = validate({
        version: data.version,
        default_model_id: typed.default_model_id,
        models: [model],
      });
      if (!itemValid) {
        for (const error of validate.errors || []) {
          violations.push(
            `model-registry/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`
          );
        }
      }
      const snapshotModel = (typed.models || []).find(
        (entry) => String(entry.model_id || '') === modelId
      );
      if (!snapshotModel) {
        violations.push(`model-registry/${file}: snapshot is missing model ${modelId}`);
      } else if (JSON.stringify(model) !== JSON.stringify(snapshotModel)) {
        violations.push(`model-registry/${file}: directory entry does not match snapshot`);
      }
      directoryModels.set(modelId, model);
    }

    if (
      JSON.stringify([...directoryModels.keys()].sort()) !== JSON.stringify([...snapshotIds].sort())
    ) {
      violations.push('model-registry: snapshot and canonical directory model IDs diverge');
    }
  }

  if (check.id === 'model-adaptation-policy') {
    const typed = data as {
      lifecycle?: { steps?: string[] };
      benchmark_suites?: Array<{ id?: string }>;
      promotion_gates?: { required_suites?: string[] };
      integration_decision_rules?: Array<{ id?: string }>;
      rollback?: { min_signal_count?: number };
    };
    const lifecycleSteps = typed.lifecycle?.steps || [];
    const requiredLifecycleSteps = [
      'detect',
      'profile',
      'evaluate',
      'adapt',
      'shadow',
      'promote_or_rollback',
    ];
    for (const step of requiredLifecycleSteps) {
      if (!lifecycleSteps.includes(step)) {
        violations.push(`model-adaptation-policy: lifecycle.steps must include ${step}`);
      }
    }
    const benchmarkIds = new Set(
      (typed.benchmark_suites || []).map((suite) => String(suite.id || ''))
    );
    if (!benchmarkIds.size) {
      violations.push('model-adaptation-policy: benchmark_suites must not be empty');
    }
    for (const suiteId of typed.promotion_gates?.required_suites || []) {
      if (!benchmarkIds.has(suiteId)) {
        violations.push(
          `model-adaptation-policy: promotion_gates.required_suites contains unknown suite id (${suiteId})`
        );
      }
    }
    const decisionRuleIds = new Set<string>();
    for (const rule of typed.integration_decision_rules || []) {
      const id = String(rule.id || '');
      if (!id) {
        violations.push('model-adaptation-policy: every integration_decision_rule must define id');
        continue;
      }
      if (decisionRuleIds.has(id)) {
        violations.push(`model-adaptation-policy: duplicate integration_decision_rule id (${id})`);
      }
      decisionRuleIds.add(id);
    }
    if ((typed.rollback?.min_signal_count || 0) < 1) {
      violations.push('model-adaptation-policy: rollback.min_signal_count must be >= 1');
    }
  }

  if (check.id === 'harness-capability-registry') {
    const typed = data as {
      capabilities?: Array<{
        capability_id?: string;
        status?: string;
        fallback_path?: { mode?: string; target?: string };
      }>;
    };
    if (!(typed.capabilities || []).length) {
      violations.push('harness-capability-registry: capabilities must not be empty');
      return;
    }
    const capabilityIds = new Set<string>();
    for (const capability of typed.capabilities || []) {
      const capabilityId = String(capability.capability_id || '');
      if (!capabilityId) {
        violations.push('harness-capability-registry: every capability must define capability_id');
        continue;
      }
      if (capabilityIds.has(capabilityId)) {
        violations.push(
          `harness-capability-registry: duplicate capability_id detected (${capabilityId})`
        );
      }
      capabilityIds.add(capabilityId);

      if (
        capability.status === 'active' &&
        capability.fallback_path?.mode !== 'none' &&
        !String(capability.fallback_path?.target || '')
      ) {
        violations.push(
          `harness-capability-registry: active capability ${capabilityId} must define fallback_path.target when fallback is enabled`
        );
      }
    }
    if (!(typed.capabilities || []).some((capability) => capability.status === 'active')) {
      violations.push('harness-capability-registry: at least one active capability is required');
    }
  }

  if (check.id === 'harness-adapter-registry') {
    const typed = data as {
      profiles?: Array<{
        adapter_id?: string;
        enabled?: boolean;
        fallback_contract?: string;
        capability_id?: string;
      }>;
    };
    if (!(typed.profiles || []).length) {
      violations.push('harness-adapter-registry: profiles must not be empty');
      return;
    }
    const adapterIds = new Set<string>();
    for (const profile of typed.profiles || []) {
      const adapterId = String(profile.adapter_id || '');
      if (!adapterId) {
        violations.push('harness-adapter-registry: every profile must define adapter_id');
        continue;
      }
      if (adapterIds.has(adapterId)) {
        violations.push(`harness-adapter-registry: duplicate adapter_id detected (${adapterId})`);
      }
      adapterIds.add(adapterId);

      if (profile.enabled && !String(profile.fallback_contract || '')) {
        violations.push(
          `harness-adapter-registry: enabled adapter ${adapterId} must define fallback_contract`
        );
      }
      if (!String(profile.capability_id || '')) {
        violations.push(`harness-adapter-registry: adapter ${adapterId} must define capability_id`);
      }
    }
    if (!(typed.profiles || []).some((profile) => profile.enabled)) {
      violations.push('harness-adapter-registry: at least one enabled profile is required');
    }
  }

  if (check.id === 'provider-capability-scan-policy') {
    const typed = data as {
      providers?: Array<{
        provider?: string;
        primary_probe?: {
          command?: string;
        };
        evidence_probes?: Array<{
          capability_ids?: string[];
          probe?: {
            command?: string;
          };
        }>;
      }>;
    };
    if (!(typed.providers || []).length) {
      violations.push('provider-capability-scan-policy: providers must not be empty');
      return;
    }
    const providerNames = new Set<string>();
    for (const provider of typed.providers || []) {
      const providerName = String(provider.provider || '');
      if (!providerName) {
        violations.push('provider-capability-scan-policy: every provider must define provider');
        continue;
      }
      if (providerNames.has(providerName)) {
        violations.push(
          `provider-capability-scan-policy: duplicate provider detected (${providerName})`
        );
      }
      providerNames.add(providerName);
      if (!String(provider.primary_probe?.command || '')) {
        violations.push(
          `provider-capability-scan-policy: provider ${providerName} must define primary_probe.command`
        );
      }
      for (const evidenceProbe of provider.evidence_probes || []) {
        if (!String(evidenceProbe.probe?.command || '')) {
          violations.push(
            `provider-capability-scan-policy: provider ${providerName} evidence probe must define probe.command`
          );
        }
        if (!(evidenceProbe.capability_ids || []).length) {
          violations.push(
            `provider-capability-scan-policy: provider ${providerName} evidence probe must define capability_ids`
          );
        }
      }
    }
  }

  if (check.id === 'execution-receipt-policy') {
    const typed = data as {
      required_sections?: string[];
      clarification?: {
        max_blocking_questions_per_turn?: number;
        must_explain_missing_inputs?: boolean;
      };
      compactness?: {
        max_interpreted_goal_chars?: number;
        max_next_action_chars?: number;
      };
      approval_binding?: {
        require_policy_refs_when_approval_required?: boolean;
        require_reason_when_approval_required?: boolean;
      };
      routing_binding?: {
        allowed_modes?: string[];
        allowed_routing?: string[];
      };
    };
    const requiredSections = new Set(typed.required_sections || []);
    for (const key of [
      'intent',
      'deliverable',
      'missing_inputs',
      'approval',
      'execution',
      'status',
    ]) {
      if (!requiredSections.has(key)) {
        violations.push(`execution-receipt-policy: required_sections must include ${key}`);
      }
    }
    if ((typed.clarification?.max_blocking_questions_per_turn || 0) > 3) {
      violations.push(
        'execution-receipt-policy: clarification.max_blocking_questions_per_turn must be <= 3'
      );
    }
    if (
      (typed.compactness?.max_next_action_chars || 0) >
      (typed.compactness?.max_interpreted_goal_chars || 0)
    ) {
      violations.push(
        'execution-receipt-policy: compactness.max_next_action_chars must be <= compactness.max_interpreted_goal_chars'
      );
    }
    if (
      typed.approval_binding?.require_policy_refs_when_approval_required &&
      !typed.approval_binding?.require_reason_when_approval_required
    ) {
      violations.push(
        'execution-receipt-policy: approval reason is required when policy refs are required for approval'
      );
    }
    if (!(typed.routing_binding?.allowed_modes || []).length) {
      violations.push('execution-receipt-policy: routing_binding.allowed_modes must not be empty');
    }
    if (!(typed.routing_binding?.allowed_routing || []).length) {
      violations.push(
        'execution-receipt-policy: routing_binding.allowed_routing must not be empty'
      );
    }
  }

  if (check.id === 'voice-profile-registry') {
    const typed = data as {
      default_profile_id?: string;
      profiles?: Array<{
        profile_id?: string;
        status?: string;
        languages?: string[];
        tier?: string;
        default_engine_id?: string;
      }>;
    };
    if (!(typed.profiles || []).length) {
      violations.push('voice-profile-registry: profiles must not be empty');
      return;
    }
    const profileIds = new Set<string>();
    for (const profile of typed.profiles || []) {
      const profileId = String(profile.profile_id || '');
      if (!profileId) {
        violations.push('voice-profile-registry: every profile must define profile_id');
        continue;
      }
      if (profileIds.has(profileId)) {
        violations.push(`voice-profile-registry: duplicate profile_id detected (${profileId})`);
      }
      profileIds.add(profileId);
      if (!(profile.languages || []).length) {
        violations.push(`voice-profile-registry: ${profileId} must define at least one language`);
      }
      if (!String(profile.tier || '')) {
        violations.push(`voice-profile-registry: ${profileId} must define tier`);
      }
      if (!String(profile.default_engine_id || '')) {
        violations.push(`voice-profile-registry: ${profileId} must define default_engine_id`);
      }
    }
    if (!String(typed.default_profile_id || '')) {
      violations.push('voice-profile-registry: default_profile_id must not be empty');
      return;
    }
    if (!profileIds.has(String(typed.default_profile_id || ''))) {
      violations.push(
        'voice-profile-registry: default_profile_id must reference an existing profile_id'
      );
    }
    if (!(typed.profiles || []).some((profile) => profile.status === 'active')) {
      violations.push('voice-profile-registry: at least one active profile is required');
    }

    const engineRegistry = readJson<{ engines?: Array<{ engine_id?: string }> }>(
      'knowledge/product/governance/voice-engine-registry.json'
    );
    const engineIds = new Set(
      (engineRegistry.engines || []).map((engine) => String(engine.engine_id || ''))
    );
    for (const profile of typed.profiles || []) {
      const profileId = String(profile.profile_id || 'unknown');
      const engineId = String(profile.default_engine_id || '');
      if (engineId && !engineIds.has(engineId)) {
        violations.push(
          `voice-profile-registry: ${profileId} references unknown default_engine_id (${engineId})`
        );
      }
    }
    validateVoiceProfileDirectoryConsistency(violations);
  }

  if (check.id === 'authority-role-index') {
    const typed = data as {
      authority_roles?: Record<string, unknown>;
    };
    if (!Object.keys(typed.authority_roles || {}).length) {
      violations.push('authority-role-index: authority_roles must not be empty');
      return;
    }
    validateAuthorityRoleDirectoryConsistency(violations);
  }

  if (check.id === 'team-role-index') {
    validateTeamRoleDirectoryConsistency(violations);
  }

  if (check.id === 'voice-runtime-policy') {
    const typed = data as {
      queue?: { concurrency?: number; cancellation?: string };
      chunking?: {
        default_max_chunk_chars?: number;
        default_crossfade_ms?: number;
      };
      progress?: { throttle_ms?: number; min_percent_delta?: number };
      routing?: {
        default_personal_voice_mode?: string;
        enforce_clone_engine_for_personal_tier?: boolean;
      };
    };
    if ((typed.queue?.concurrency || 0) < 1) {
      violations.push('voice-runtime-policy: queue.concurrency must be >= 1');
    }
    if ((typed.chunking?.default_max_chunk_chars || 0) < 100) {
      violations.push('voice-runtime-policy: chunking.default_max_chunk_chars must be >= 100');
    }
    if ((typed.chunking?.default_crossfade_ms || 0) > 500) {
      violations.push('voice-runtime-policy: chunking.default_crossfade_ms must be <= 500');
    }
    if ((typed.progress?.throttle_ms || 0) < 50) {
      violations.push('voice-runtime-policy: progress.throttle_ms must be >= 50');
    }
    if ((typed.progress?.min_percent_delta || 0) < 0) {
      violations.push('voice-runtime-policy: progress.min_percent_delta must be >= 0');
    }
    if (
      !['allow_fallback', 'require_personal_voice'].includes(
        String(typed.routing?.default_personal_voice_mode || '')
      )
    ) {
      violations.push(
        'voice-runtime-policy: routing.default_personal_voice_mode must be allow_fallback or require_personal_voice'
      );
    }
    if (typed.routing?.enforce_clone_engine_for_personal_tier === undefined) {
      violations.push(
        'voice-runtime-policy: routing.enforce_clone_engine_for_personal_tier must be defined'
      );
    }
  }

  if (check.id === 'voice-engine-registry') {
    const typed = data as {
      default_engine_id?: string;
      engines?: Array<{
        engine_id?: string;
        status?: string;
        fallback_engine_id?: string;
        supports?: { playback?: boolean; artifact_formats?: string[] };
      }>;
    };
    if (!(typed.engines || []).length) {
      violations.push('voice-engine-registry: engines must not be empty');
      return;
    }
    const engineIds = new Set<string>();
    for (const engine of typed.engines || []) {
      const engineId = String(engine.engine_id || '');
      if (!engineId) {
        violations.push('voice-engine-registry: every engine must define engine_id');
        continue;
      }
      if (engineIds.has(engineId)) {
        violations.push(`voice-engine-registry: duplicate engine_id detected (${engineId})`);
      }
      engineIds.add(engineId);
      if (
        engine.supports?.playback === false &&
        (engine.supports?.artifact_formats || []).length === 0
      ) {
        violations.push(
          `voice-engine-registry: ${engineId} must support playback or at least one artifact format`
        );
      }
    }
    if (!String(typed.default_engine_id || '')) {
      violations.push('voice-engine-registry: default_engine_id must not be empty');
      return;
    }
    if (!engineIds.has(String(typed.default_engine_id || ''))) {
      violations.push(
        'voice-engine-registry: default_engine_id must reference an existing engine_id'
      );
    }
    if (!(typed.engines || []).some((engine) => engine.status === 'active')) {
      violations.push('voice-engine-registry: at least one active engine is required');
    }
    for (const engine of typed.engines || []) {
      const engineId = String(engine.engine_id || '');
      const fallbackId = String(engine.fallback_engine_id || '');
      if (fallbackId && !engineIds.has(fallbackId)) {
        violations.push(
          `voice-engine-registry: ${engineId} references unknown fallback_engine_id (${fallbackId})`
        );
      }
      if (fallbackId && fallbackId === engineId) {
        violations.push(
          `voice-engine-registry: ${engineId} must not reference itself as fallback_engine_id`
        );
      }
    }
  }

  if (check.id === 'voice-sample-ingestion-policy') {
    const typed = data as {
      sample_limits?: {
        min_samples?: number;
        max_samples?: number;
        min_sample_bytes?: number;
        max_sample_bytes?: number;
        allowed_extensions?: string[];
      };
      profile_rules?: {
        allowed_tiers?: string[];
        require_unique_sample_paths?: boolean;
        require_language_coverage?: boolean;
      };
    };
    if ((typed.sample_limits?.min_samples || 0) < 1) {
      violations.push('voice-sample-ingestion-policy: sample_limits.min_samples must be >= 1');
    }
    if ((typed.sample_limits?.max_samples || 0) < (typed.sample_limits?.min_samples || 0)) {
      violations.push(
        'voice-sample-ingestion-policy: sample_limits.max_samples must be >= sample_limits.min_samples'
      );
    }
    if ((typed.sample_limits?.min_sample_bytes || 0) < 1024) {
      violations.push(
        'voice-sample-ingestion-policy: sample_limits.min_sample_bytes must be >= 1024'
      );
    }
    if (
      (typed.sample_limits?.max_sample_bytes || 0) < (typed.sample_limits?.min_sample_bytes || 0)
    ) {
      violations.push(
        'voice-sample-ingestion-policy: sample_limits.max_sample_bytes must be >= sample_limits.min_sample_bytes'
      );
    }
    if (!(typed.sample_limits?.allowed_extensions || []).length) {
      violations.push(
        'voice-sample-ingestion-policy: sample_limits.allowed_extensions must not be empty'
      );
    }
    if (!(typed.profile_rules?.allowed_tiers || []).length) {
      violations.push(
        'voice-sample-ingestion-policy: profile_rules.allowed_tiers must not be empty'
      );
    }
    if (typed.profile_rules?.require_unique_sample_paths === undefined) {
      violations.push(
        'voice-sample-ingestion-policy: profile_rules.require_unique_sample_paths must be defined'
      );
    }
    if (typed.profile_rules?.require_language_coverage === undefined) {
      violations.push(
        'voice-sample-ingestion-policy: profile_rules.require_language_coverage must be defined'
      );
    }
  }

  if (check.id === 'video-composition-template-registry') {
    const typed = data as {
      default_template_id?: string;
      templates?: Array<{
        template_id?: string;
        status?: string;
        supported_roles?: string[];
        required_content_fields?: string[];
        supported_output_formats?: string[];
      }>;
    };
    if (!(typed.templates || []).length) {
      violations.push('video-composition-template-registry: templates must not be empty');
      return;
    }
    const templateIds = new Set<string>();
    for (const template of typed.templates || []) {
      const templateId = String(template.template_id || '');
      if (!templateId) {
        violations.push(
          'video-composition-template-registry: every template must define template_id'
        );
        continue;
      }
      if (templateIds.has(templateId)) {
        violations.push(
          `video-composition-template-registry: duplicate template_id detected (${templateId})`
        );
      }
      templateIds.add(templateId);
      if (!(template.supported_roles || []).length) {
        violations.push(
          `video-composition-template-registry: ${templateId} must define supported_roles`
        );
      }
      if (!(template.required_content_fields || []).length) {
        violations.push(
          `video-composition-template-registry: ${templateId} must define required_content_fields`
        );
      }
      if (!(template.supported_output_formats || []).length) {
        violations.push(
          `video-composition-template-registry: ${templateId} must define supported_output_formats`
        );
      }
    }
    if (!String(typed.default_template_id || '')) {
      violations.push('video-composition-template-registry: default_template_id must not be empty');
      return;
    }
    if (!templateIds.has(String(typed.default_template_id || ''))) {
      violations.push(
        'video-composition-template-registry: default_template_id must reference an existing template_id'
      );
    }
    if (!(typed.templates || []).some((template) => template.status === 'active')) {
      violations.push(
        'video-composition-template-registry: at least one active template is required'
      );
    }
  }

  if (check.id === 'video-render-runtime-policy') {
    const typed = data as {
      queue?: { concurrency?: number };
      progress?: { throttle_ms?: number; min_percent_delta?: number };
      bundle?: { default_bundle_root?: string };
      render?: {
        allowed_output_formats?: string[];
        backend?: string;
        quality?: string;
        command_timeout_ms?: number;
      };
    };
    if ((typed.queue?.concurrency || 0) < 1) {
      violations.push('video-render-runtime-policy: queue.concurrency must be >= 1');
    }
    if ((typed.progress?.throttle_ms || 0) < 50) {
      violations.push('video-render-runtime-policy: progress.throttle_ms must be >= 50');
    }
    if ((typed.progress?.min_percent_delta || 0) < 0) {
      violations.push('video-render-runtime-policy: progress.min_percent_delta must be >= 0');
    }
    if (!String(typed.bundle?.default_bundle_root || '')) {
      violations.push('video-render-runtime-policy: bundle.default_bundle_root must not be empty');
    }
    if (!(typed.render?.allowed_output_formats || []).length) {
      violations.push(
        'video-render-runtime-policy: render.allowed_output_formats must not be empty'
      );
    }
    if (!['none', 'hyperframes_cli'].includes(String(typed.render?.backend || ''))) {
      violations.push(
        'video-render-runtime-policy: render.backend must be one of none|hyperframes_cli'
      );
    }
    if (!['draft', 'standard', 'high'].includes(String(typed.render?.quality || ''))) {
      violations.push(
        'video-render-runtime-policy: render.quality must be one of draft|standard|high'
      );
    }
    if ((typed.render?.command_timeout_ms || 0) < 1000) {
      violations.push('video-render-runtime-policy: render.command_timeout_ms must be >= 1000');
    }
  }
}

// ── (c) Machine-absolute path lint ────────────────────────────────────────
// Committed config/code must not embed a machine-specific filesystem prefix
// (e.g. a `<home>/<user>/...` absolute path) — those break the moment the repo
// runs on another machine. Paths should be repo-relative and resolved at runtime via
// pathResolver / the `system:resolve_path` op. A line may opt out with the
// inline marker `governance-allow-abs-path` (e.g. this scanner's own pattern,
// or a test fixture that intentionally asserts on an absolute path).

export const runCheckGovernanceRules = defineScript({
  name: 'check:governance-rules',
  flags: [],
  run(context) {
    const violations: string[] = [];
    for (const check of CHECKS) {
      validateRuleFile(check, violations);
    }
    validateActuatorCatalogDirectoryConsistency(violations);
    findMachineAbsolutePathViolations(violations);
    scanProductJsonForPlacementDrift(violations);
    try {
      assertProcessDefinitionRegistry();
    } catch (error) {
      violations.push(
        `process-definition-registry: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const deterministicCatalog of findDeterministicCatalogViolations()) {
      violations.push(
        `governance-catalog: deterministic catalog must be removed or migrated (${deterministicCatalog})`
      );
    }

    if (violations.length > 0) {
      console.error('[check:governance-rules] violations detected:');
      for (const violation of violations.sort()) {
        console.error(`- ${violation}`);
      }
      process.exitCode = 1;
      return;
    }

    context.print('[check:governance-rules] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_governance_rules.ts') ||
  isDirectScript(import.meta.url, 'check_governance_rules.js')
)
  void runCheckGovernanceRules();
