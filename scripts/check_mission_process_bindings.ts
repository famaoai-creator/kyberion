import * as yaml from 'js-yaml';
import {
  loadJson,
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core';

type JsonRecord = Record<string, any>;

const ROOT = pathResolver.rootDir();
const rel = (value: string) => pathResolver.rootResolve(value);

function readJson(path: string): JsonRecord {
  return loadJson<JsonRecord>(rel(path));
}

function addValuesAtKey(value: unknown, key: string, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [entryKey, entryValue] of Object.entries(value as JsonRecord)) {
    if (entryKey === key) {
      if (typeof entryValue === 'string') out.add(entryValue);
      if (Array.isArray(entryValue))
        entryValue.forEach((item) => typeof item === 'string' && out.add(item));
    }
    addValuesAtKey(entryValue, key, out);
  }
}

function parseFrontmatter(path: string): JsonRecord {
  const raw = String(safeReadFile(rel(path), { encoding: 'utf8' }));
  if (!raw.startsWith('---\n')) return {};
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return {};
  const parsed = yaml.load(raw.slice(4, end));
  return parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
}

function allGateIds(
  catalog: JsonRecord,
  review: JsonRecord,
  gateProfiles: JsonRecord
): Set<string> {
  const ids = new Set<string>();
  addValuesAtKey(review, 'gate_id', ids);
  addValuesAtKey(catalog, 'id', ids);
  addValuesAtKey(gateProfiles, 'mission_gate_id', ids);
  // Catalog phase ids are not gates; remove known lifecycle stages from the broad id scan.
  for (const stage of [
    'intake',
    'classification',
    'planning',
    'contract_authoring',
    'preflight',
    'execution',
    'verification',
    'delivery',
    'retrospective',
  ])
    ids.delete(stage);
  return ids;
}

export function findMissionProcessBindingViolations(): string[] {
  const violations: string[] = [];
  const processRegistry = readJson('knowledge/product/governance/mission-process-registry.json');
  const declaredLayers = new Set(
    (processRegistry.layers || []).map((layer: JsonRecord) => String(layer.id))
  );
  for (const layer of ['runtime', 'verification', 'knowledge']) {
    if (!declaredLayers.has(layer))
      violations.push(`mission-process-registry: missing layer ${layer}`);
  }
  for (const layer of processRegistry.layers || []) {
    for (const artifact of layer.artifacts || []) {
      if (!safeExistsSync(rel(String(artifact.path))))
        violations.push(`mission-process-registry/${layer.id}: missing artifact ${artifact.path}`);
      for (const validator of artifact.validated_by || []) {
        if (String(validator).includes('/') && !safeExistsSync(rel(String(validator))))
          violations.push(`mission-process-registry/${layer.id}: missing validator ${validator}`);
      }
    }
  }
  const catalog = readJson('knowledge/product/governance/mission-workflow-catalog.json');
  const classificationPolicy = readJson(
    'knowledge/product/governance/mission-classification-policy.json'
  );
  const reviewRegistry = readJson('knowledge/product/governance/mission-review-gate-registry.json');
  const gateProfiles = readJson(
    'knowledge/product/governance/gate-profiles/gate-profile-registry.json'
  );
  const standardIntents = readJson('knowledge/product/governance/standard-intents.json');
  const orchestration = readJson(
    'knowledge/product/governance/mission-orchestration-scenario-pack.json'
  );
  const classification = readJson(
    'knowledge/product/governance/mission-task-classification-scenarios.json'
  );

  const workflowIds = new Set(
    (catalog.templates || []).map((entry: JsonRecord) => String(entry.id))
  );
  const workflowPatterns = new Set(Object.keys(catalog.patterns || {}));
  const missionClasses = new Set<string>();
  const deliveryShapes = new Set<string>();
  const riskProfiles = new Set<string>();
  const stages = new Set<string>(classificationPolicy.stage_progression || []);
  addValuesAtKey(classificationPolicy, 'mission_class', missionClasses);
  addValuesAtKey(catalog, 'mission_classes', missionClasses);
  addValuesAtKey(classificationPolicy, 'delivery_shape', deliveryShapes);
  addValuesAtKey(catalog, 'delivery_shapes', deliveryShapes);
  addValuesAtKey(classificationPolicy, 'risk_profile', riskProfiles);
  addValuesAtKey(catalog, 'risk_profiles', riskProfiles);
  const intentIds = new Set(
    (standardIntents.intents || []).map((entry: JsonRecord) => String(entry.id))
  );
  const gateIds = allGateIds(catalog, reviewRegistry, gateProfiles);

  if (orchestration.purpose !== 'regression-fixture')
    violations.push('orchestration scenario pack purpose must be regression-fixture');
  if (classification.purpose !== 'regression-fixture')
    violations.push('classification scenario pack purpose must be regression-fixture');

  for (const scenario of orchestration.scenarios || []) {
    const prefix = `orchestration/${scenario.scenario_id}`;
    if (!missionClasses.has(scenario.mission_class))
      violations.push(`${prefix}: unknown mission_class ${scenario.mission_class}`);
    if (!deliveryShapes.has(scenario.delivery_shape))
      violations.push(`${prefix}: unknown delivery_shape ${scenario.delivery_shape}`);
    if (!workflowPatterns.has(scenario.workflow_pattern))
      violations.push(`${prefix}: unknown workflow_pattern ${scenario.workflow_pattern}`);
  }
  for (const scenario of classification.scenarios || []) {
    const prefix = `classification/${scenario.scenario_id}`;
    const expected = scenario.expected || {};
    for (const [name, value, allowed] of [
      ['intent_id', expected.intent_id, intentIds],
      ['workflow_id', expected.workflow_id, workflowIds],
      ['workflow_pattern', expected.workflow_pattern, workflowPatterns],
      ['mission_class', expected.mission_class, missionClasses],
      ['delivery_shape', expected.delivery_shape, deliveryShapes],
      ['risk_profile', expected.risk_profile, riskProfiles],
      ['stage', expected.stage, stages],
    ] as Array<[string, string, Set<string>]>) {
      if (!allowed.has(String(value)))
        violations.push(`${prefix}: unknown ${name} ${String(value)}`);
    }
    for (const gateId of expected.required_gate_ids || []) {
      if (!gateIds.has(gateId)) violations.push(`${prefix}: unknown gate id ${gateId}`);
    }
  }

  const playbookDir = 'knowledge/product/orchestration/mission-playbooks';
  const playbookPaths = new Set(
    safeReaddir(rel(playbookDir))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => `${playbookDir}/${entry}`)
  );
  const catalogRefs = new Map<string, string[]>();
  for (const template of catalog.templates || []) {
    if (template.playbook_ref) {
      const ref = String(template.playbook_ref);
      if (!safeExistsSync(rel(ref)))
        violations.push(`workflow/${template.id}: missing playbook_ref ${ref}`);
      if (!catalogRefs.has(ref)) catalogRefs.set(ref, []);
      catalogRefs.get(ref)!.push(String(template.id));
    }
    const description = String(template.description || '');
    for (const match of description.matchAll(/mission-playbooks\/([A-Za-z0-9._-]+\.md)/gu)) {
      const ref = `${playbookDir}/${match[1]}`;
      if (!playbookPaths.has(ref))
        violations.push(`workflow/${template.id}: missing prose playbook ${ref}`);
    }
  }
  for (const playbookPath of playbookPaths) {
    const frontmatter = parseFrontmatter(playbookPath);
    const workflowIdsFromDoc = Array.isArray(frontmatter.workflow_ids)
      ? frontmatter.workflow_ids.map(String)
      : [];
    for (const workflowId of workflowIdsFromDoc) {
      if (!workflowIds.has(workflowId))
        violations.push(`${playbookPath}: unknown workflow_id ${workflowId}`);
      if (!catalogRefs.get(playbookPath)?.includes(workflowId))
        violations.push(
          `${playbookPath}: workflow_id ${workflowId} has no matching catalog playbook_ref`
        );
    }
    for (const workflowId of catalogRefs.get(playbookPath) || []) {
      if (!workflowIdsFromDoc.includes(workflowId))
        violations.push(
          `${playbookPath}: missing workflow_id ${workflowId} for catalog playbook_ref`
        );
    }
  }

  const phaseDir = 'knowledge/product/governance/phases';
  for (const entry of safeReaddir(rel(phaseDir)).filter((name) => name.endsWith('.md'))) {
    const phasePath = `${phaseDir}/${entry}`;
    const frontmatter = parseFrontmatter(phasePath);
    const runtimeStages = Array.isArray(frontmatter.runtime_stages)
      ? frontmatter.runtime_stages.map(String)
      : [];
    if (runtimeStages.length === 0)
      violations.push(`${phasePath}: runtime_stages frontmatter is required`);
    for (const runtimeStage of runtimeStages)
      if (!stages.has(runtimeStage))
        violations.push(`${phasePath}: unknown runtime stage ${runtimeStage}`);
  }
  return violations;
}

export function main(): void {
  const violations = findMissionProcessBindingViolations();
  if (violations.length) {
    console.error('[check:mission-process-bindings] violations detected:');
    for (const violation of violations.sort()) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check:mission-process-bindings] OK');
}

if (process.argv[1] && /check_mission_process_bindings\.(ts|js)$/u.test(process.argv[1])) main();
