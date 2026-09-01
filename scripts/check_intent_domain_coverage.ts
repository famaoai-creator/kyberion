import { pathResolver } from '@agent/core/path-resolver';
import { safeReaddir } from '@agent/core/secure-io';
import { loadActuatorManifestCatalog } from '@agent/core/src/actuator-manifest-index';
import { loadStandardIntentCatalog } from '@agent/core/intent-resolution';
import { loadIntentDomainOntologyCatalog } from '@agent/core/intent-resolution';
import { loadMissionClassificationPolicy } from '@agent/core/mission-classification';
import { loadMissionTeamTemplates } from '@agent/core/mission-team-index';
import { loadMissionWorkflowCatalog } from '@agent/core/mission-workflow-catalog';
import { loadOutcomeCatalog } from '@agent/core/work-design';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type StandardIntent = {
  id?: string;
  category?: string;
  target?: string;
  action?: string;
  object?: string;
  execution_shape?: string;
  mission_class?: string;
  risk_profile?: string;
  outcome_ids?: string[];
};

type IntentDomainEntry = {
  intent_id: string;
  category: string;
  legacy_category: string;
  target: string;
  action: string;
  object: string;
  execution_shape: string;
  mission_class: string;
  workflow_template: string;
  team_template: string;
  risk_profile: string;
  outcome_ids: string[];
  actuator_requirements: string[];
  readiness_required: string[];
};

function pushIfMissing<T>(
  collection: Set<T>,
  value: T,
  message: string,
  violations: string[]
): void {
  if (!collection.has(value)) violations.push(message);
}

export function checkIntentDomainCoverage(): string[] {
  const standardIntents = loadStandardIntentCatalog();
  const ontology = loadIntentDomainOntologyCatalog() as { intents: IntentDomainEntry[] };
  const missionClassification = loadMissionClassificationPolicy();
  const workflowCatalog = loadMissionWorkflowCatalog();
  const teamTemplates = loadMissionTeamTemplates();
  const outcomeCatalog = loadOutcomeCatalog();
  const manifests = pathResolver.rootResolve('knowledge/product/governance/environment-manifests');

  const readinessManifestIds = new Set(
    safeReaddir(manifests)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
  );

  const standardById = new Map<string, StandardIntent>();
  for (const intent of standardIntents) {
    if (!intent.id) continue;
    standardById.set(intent.id, intent);
  }

  const ontologyById = new Map<string, IntentDomainEntry>();
  const violations: string[] = [];
  for (const entry of ontology.intents || []) {
    if (ontologyById.has(entry.intent_id)) {
      violations.push(`intent-domain-ontology: duplicated intent_id (${entry.intent_id})`);
      continue;
    }
    ontologyById.set(entry.intent_id, entry);
  }

  for (const [intentId, intent] of standardById.entries()) {
    const entry = ontologyById.get(intentId);
    if (!entry) {
      violations.push(`intent-domain-ontology: missing entry for standard intent (${intentId})`);
      continue;
    }
    if (entry.category !== String(intent.category || '')) {
      violations.push(
        `intent-domain-ontology: category mismatch for ${intentId} (expected ${String(intent.category || '')}, got ${entry.category})`
      );
    }
    if (entry.target !== String(intent.target || '')) {
      violations.push(
        `intent-domain-ontology: target mismatch for ${intentId} (expected ${String(intent.target || '')}, got ${entry.target})`
      );
    }
    if (entry.action !== String(intent.action || '')) {
      violations.push(
        `intent-domain-ontology: action mismatch for ${intentId} (expected ${String(intent.action || '')}, got ${entry.action})`
      );
    }
    if (entry.object !== String(intent.object || '')) {
      violations.push(
        `intent-domain-ontology: object mismatch for ${intentId} (expected ${String(intent.object || '')}, got ${entry.object})`
      );
    }
    if (entry.mission_class !== String(intent.mission_class || '')) {
      violations.push(
        `intent-domain-ontology: mission_class mismatch for ${intentId} (expected ${String(intent.mission_class || '')}, got ${entry.mission_class})`
      );
    }
    if (entry.execution_shape !== String(intent.execution_shape || '')) {
      violations.push(
        `intent-domain-ontology: execution_shape mismatch for ${intentId} (expected ${String(intent.execution_shape || '')}, got ${entry.execution_shape})`
      );
    }
    if (entry.risk_profile !== String(intent.risk_profile || '')) {
      violations.push(
        `intent-domain-ontology: risk_profile mismatch for ${intentId} (expected ${String(intent.risk_profile || '')}, got ${entry.risk_profile})`
      );
    }
    if (!Array.isArray(intent.outcome_ids) || intent.outcome_ids.length === 0) {
      violations.push(`standard-intents: ${intentId} must define at least one outcome_id`);
    }
  }

  for (const intentId of ontologyById.keys()) {
    if (!standardById.has(intentId)) {
      violations.push(
        `intent-domain-ontology: unknown intent_id not found in standard-intents (${intentId})`
      );
    }
  }

  const missionClasses = new Set<string>([
    missionClassification.defaults.mission_class,
    ...missionClassification.mission_class_rules.map((rule) => String(rule.mission_class || '')),
  ]);
  const workflowIds = new Set(
    (workflowCatalog.templates || []).map((template) => String(template.id || ''))
  );
  const teamTemplateIds = new Set(Object.keys(teamTemplates || {}));
  const actuatorIds = new Set(
    loadActuatorManifestCatalog().map((actuator) => String(actuator.n || ''))
  );
  const outcomeIds = new Set(Object.keys(outcomeCatalog || {}));

  for (const entry of ontology.intents || []) {
    pushIfMissing(
      missionClasses,
      entry.mission_class,
      `intent-domain-ontology: ${entry.intent_id} references unknown mission_class (${entry.mission_class})`,
      violations
    );
    pushIfMissing(
      workflowIds,
      entry.workflow_template,
      `intent-domain-ontology: ${entry.intent_id} references unknown workflow_template (${entry.workflow_template})`,
      violations
    );
    pushIfMissing(
      teamTemplateIds,
      entry.team_template,
      `intent-domain-ontology: ${entry.intent_id} references unknown team_template (${entry.team_template})`,
      violations
    );

    for (const actuatorId of entry.actuator_requirements || []) {
      pushIfMissing(
        actuatorIds,
        actuatorId,
        `intent-domain-ontology: ${entry.intent_id} references unknown actuator (${actuatorId})`,
        violations
      );
    }
    for (const manifestId of entry.readiness_required || []) {
      pushIfMissing(
        readinessManifestIds,
        manifestId,
        `intent-domain-ontology: ${entry.intent_id} references unknown readiness manifest (${manifestId})`,
        violations
      );
    }
    for (const outcomeId of entry.outcome_ids || []) {
      pushIfMissing(
        outcomeIds,
        outcomeId,
        `intent-domain-ontology: ${entry.intent_id} references unknown outcome_id (${outcomeId})`,
        violations
      );
    }
  }

  return violations;
}

export const runCheckIntentDomainCoverage = defineScript({
  name: 'check:intent-domain-coverage',
  flags: [],
  run(context) {
    const violations = checkIntentDomainCoverage();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'intent domain coverage check failed',
          ...violations.map((violation) => `- ${violation}`),
        ].join('\n')
      );
    }
    const intentCount = loadIntentDomainOntologyCatalog().intents.length;
    context.print(`[check:intent-domain-coverage] OK (${intentCount} intents)`);
    return { intents: intentCount, violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_intent_domain_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_intent_domain_coverage.js')
)
  void runCheckIntentDomainCoverage();
