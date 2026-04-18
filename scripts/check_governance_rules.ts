import * as AjvModule from 'ajv';
import { pathResolver, safeReadFile } from '@agent/core';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

type GovernanceRuleCheck = {
  id: string;
  schemaPath: string;
  dataPath: string;
};

const CHECKS: GovernanceRuleCheck[] = [
  {
    id: 'intent-policy',
    schemaPath: 'knowledge/public/schemas/intent-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-policy.json',
  },
  {
    id: 'intent-resolution-policy',
    schemaPath: 'knowledge/public/schemas/intent-resolution-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-resolution-policy.json',
  },
  {
    id: 'task-session-policy',
    schemaPath: 'knowledge/public/schemas/task-session-policy.schema.json',
    dataPath: 'knowledge/public/governance/task-session-policy.json',
  },
  {
    id: 'work-policy',
    schemaPath: 'knowledge/public/schemas/work-policy.schema.json',
    dataPath: 'knowledge/public/governance/work-policy.json',
  },
  {
    id: 'standard-intents',
    schemaPath: 'knowledge/public/schemas/standard-intents.schema.json',
    dataPath: 'knowledge/public/governance/standard-intents.json',
  },
  {
    id: 'active-surfaces',
    schemaPath: 'knowledge/public/schemas/runtime-surface-manifest.schema.json',
    dataPath: 'knowledge/public/governance/active-surfaces.json',
  },
  {
    id: 'surface-policy',
    schemaPath: 'knowledge/public/schemas/surface-policy.schema.json',
    dataPath: 'knowledge/public/governance/surface-policy.json',
  },
  {
    id: 'model-registry',
    schemaPath: 'knowledge/public/schemas/model-registry.schema.json',
    dataPath: 'knowledge/public/governance/model-registry.json',
  },
  {
    id: 'model-adaptation-policy',
    schemaPath: 'knowledge/public/schemas/model-adaptation-policy.schema.json',
    dataPath: 'knowledge/public/governance/model-adaptation-policy.json',
  },
  {
    id: 'harness-capability-registry',
    schemaPath: 'knowledge/public/schemas/harness-capability-registry.schema.json',
    dataPath: 'knowledge/public/governance/harness-capability-registry.json',
  },
];

function readJson<T>(relativePath: string): T {
  const fullPath = pathResolver.rootResolve(relativePath);
  return JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string) as T;
}

function validateRuleFile(check: GovernanceRuleCheck, violations: string[]) {
  const schema = readJson<Record<string, unknown>>(check.schemaPath);
  const data = readJson<Record<string, unknown>>(check.dataPath);
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    for (const error of validate.errors || []) {
      violations.push(`${check.id}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
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
      violations.push('work-policy: profile_routing.defaults.execution_boundary_profile_id must not be empty');
    }
    if (!String(typed.profile_routing?.defaults?.runtime_design_profile_id || '')) {
      violations.push('work-policy: profile_routing.defaults.runtime_design_profile_id must not be empty');
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

  if (check.id === 'surface-policy') {
    const typed = data as {
      routing?: {
        text_routing?: { greeting_patterns?: unknown[]; receiver_rules?: unknown[] };
        compiled_flow_rules?: unknown[];
      };
      slack?: {
        intent_rules?: { rules?: unknown[]; default_label?: string };
        surface_rules?: {
          execution_mode?: { feasibility_patterns?: unknown[]; durable_task_patterns?: unknown[] };
          delegation?: { lightweight_patterns?: unknown[] };
        };
      };
    };
    if (!(typed.routing?.text_routing?.greeting_patterns || []).length) {
      violations.push('surface-policy: routing.text_routing.greeting_patterns must not be empty');
    }
    if (!(typed.routing?.text_routing?.receiver_rules || []).length) {
      violations.push('surface-policy: routing.text_routing.receiver_rules must not be empty');
    }
    if (!(typed.routing?.compiled_flow_rules || []).length) {
      violations.push('surface-policy: routing.compiled_flow_rules must not be empty');
    }
    if (!(typed.slack?.intent_rules?.rules || []).length) {
      violations.push('surface-policy: slack.intent_rules.rules must not be empty');
    }
    if (!String(typed.slack?.intent_rules?.default_label || '')) {
      violations.push('surface-policy: slack.intent_rules.default_label must not be empty');
    }
    if (!(typed.slack?.surface_rules?.execution_mode?.feasibility_patterns || []).length) {
      violations.push('surface-policy: slack.surface_rules.execution_mode.feasibility_patterns must not be empty');
    }
    if (!(typed.slack?.surface_rules?.execution_mode?.durable_task_patterns || []).length) {
      violations.push('surface-policy: slack.surface_rules.execution_mode.durable_task_patterns must not be empty');
    }
    if (!(typed.slack?.surface_rules?.delegation?.lightweight_patterns || []).length) {
      violations.push('surface-policy: slack.surface_rules.delegation.lightweight_patterns must not be empty');
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
      violations.push('intent-resolution-policy: catalog_scoring.selected_confidence_threshold must be > 0');
    }
    if (!String(typed.catalog_scoring?.catalog_intent_category || '')) {
      violations.push('intent-resolution-policy: catalog_scoring.catalog_intent_category must not be empty');
    }
    if (!(typed.legacy_candidates || []).length) {
      violations.push('intent-resolution-policy: legacy_candidates must not be empty');
    }
    for (const candidate of typed.legacy_candidates || []) {
      if (!String(candidate.intent_id || '')) {
        violations.push('intent-resolution-policy: every legacy candidate must define intent_id');
      }
      if (!(candidate.patterns || []).length) {
        violations.push(`intent-resolution-policy: ${String(candidate.intent_id || 'unknown')} must define patterns`);
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
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define task_type`);
      }
      if (!String(intent.goal?.summary || '')) {
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define goal.summary`);
      }
      if (!String(intent.goal?.success_condition || '')) {
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define goal.success_condition`);
      }
    }
  }

  if (check.id === 'standard-intents') {
    const typed = data as { intents?: Array<{ id?: string; category?: string; trigger_keywords?: unknown[] }> };
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
      if (!(intent.trigger_keywords || []).length) {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define trigger_keywords`);
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
    const defaultModel = (typed.models || []).find((model) => model.model_id === typed.default_model_id);
    if (!defaultModel) {
      violations.push('model-registry: default_model_id must reference an existing model_id');
      return;
    }
    if (defaultModel.status !== 'approved') {
      violations.push('model-registry: default_model_id must point to an approved model');
    }
    if (!(typed.models || []).some((model) => model.status === 'candidate')) {
      violations.push('model-registry: at least one candidate model is required for shadow adaptation');
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
    const requiredLifecycleSteps = ['detect', 'profile', 'evaluate', 'adapt', 'shadow', 'promote_or_rollback'];
    for (const step of requiredLifecycleSteps) {
      if (!lifecycleSteps.includes(step)) {
        violations.push(`model-adaptation-policy: lifecycle.steps must include ${step}`);
      }
    }
    const benchmarkIds = new Set((typed.benchmark_suites || []).map((suite) => String(suite.id || '')));
    if (!benchmarkIds.size) {
      violations.push('model-adaptation-policy: benchmark_suites must not be empty');
    }
    for (const suiteId of typed.promotion_gates?.required_suites || []) {
      if (!benchmarkIds.has(suiteId)) {
        violations.push(`model-adaptation-policy: promotion_gates.required_suites contains unknown suite id (${suiteId})`);
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
        violations.push(`harness-capability-registry: duplicate capability_id detected (${capabilityId})`);
      }
      capabilityIds.add(capabilityId);

      if (capability.status === 'active' && capability.fallback_path?.mode !== 'none' && !String(capability.fallback_path?.target || '')) {
        violations.push(`harness-capability-registry: active capability ${capabilityId} must define fallback_path.target when fallback is enabled`);
      }
    }
    if (!(typed.capabilities || []).some((capability) => capability.status === 'active')) {
      violations.push('harness-capability-registry: at least one active capability is required');
    }
  }

}

function main() {
  const violations: string[] = [];
  for (const check of CHECKS) {
    validateRuleFile(check, violations);
  }

  if (violations.length > 0) {
    console.error('[check:governance-rules] violations detected:');
    for (const violation of violations.sort()) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[check:governance-rules] OK');
}

main();
