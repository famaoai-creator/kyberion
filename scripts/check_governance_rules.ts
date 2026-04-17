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
