/**
 * register_workflow.ts
 *
 * Dynamically register a new mission workflow from a compact registration request.
 * Expands the request into schema-valid catalog entries that pass check:governance-rules
 * and check:workflow-catalog-refs:
 *   - a mission-workflow-catalog template (intake/classification/preflight scaffolded)
 *   - a standard-intents entry
 *   - an intent-domain-ontology entry
 *   - a track_intent_policy_map routing entry (optional)
 *   - optional gate-profile-registry gates and governance-body-registry bodies
 *
 * Modes:
 *   --request <path>   (required) the registration-request JSON
 *   --propose          (default) write a ready-to-merge proposal bundle to
 *                      active/shared/tmp/workflow-registration-proposals/<id>/
 *   --apply            merge the entries into the governed catalogs in place, idempotent
 *                      by id (authority role: register_workflow). Run `pnpm validate`
 *                      (or the governance checks) afterwards to gate the change.
 *
 * The request is validated against schemas/workflow-registration-request.schema.json.
 * All I/O goes through @agent/core secure-io. This tool never writes secrets or
 * customer-specific values; those belong in confidential-tier instantiations.
 */

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import * as AjvModule from 'ajv';
import * as path from 'node:path';

const AjvCtor = ((AjvModule as { default?: unknown }).default ?? AjvModule) as new (
  opts?: Record<string, unknown>
) => { compile: (schema: unknown) => (data: unknown) => boolean & { errors?: unknown } };

const CATALOG_REL = 'knowledge/product/governance/mission-workflow-catalog.json';
const INTENTS_REL = 'knowledge/product/governance/standard-intents.json';
const ONTOLOGY_REL = 'knowledge/product/governance/intent-domain-ontology.json';
const ROUTING_REL = 'knowledge/product/governance/intent-routing-map.json';
const GATE_PROFILES_REL = 'knowledge/product/governance/gate-profiles/gate-profile-registry.json';
const GOV_BODY_REL = 'knowledge/product/governance/governance-body-registry.json';
const SCHEMA_REL = 'knowledge/product/schemas/workflow-registration-request.schema.json';
const PROPOSALS_REL = 'active/shared/tmp/workflow-registration-proposals';
const DEFAULT_WORKFLOW = 'single-track-default';

type Json = Record<string, unknown>;

interface PhaseSpec {
  id: string;
  title: string;
  kind: 'judgment' | 'deterministic' | 'review' | 'approval';
  gate_id: string;
  checks: Array<'evidence_exists' | 'reviewer_approved' | 'deliverable_quality' | 'human_override'>;
  preflight_before?: boolean;
  team_role?: string;
  description?: string;
  deliverable?: string;
  deliverable_kind?: 'doc' | 'deck' | 'code' | 'media';
  pipeline_ref?: string;
  acceptance_criteria?: string[];
  estimated_scope?: 'S' | 'M' | 'L';
  risk?: 'low' | 'medium' | 'high' | 'approval_required' | 'high_stakes';
  review_target_suffix?: string;
}

interface IntentSpec {
  target: string;
  action: string;
  object: string;
  outcome_ids: string[];
  specialist_id: string;
  trigger_keywords: string[];
  surface_examples?: string[];
  plan_outline?: string[];
  intake_requirements?: string[];
  actuator_requirements: string[];
  exposed_to_surface?: boolean;
}

interface RegistrationRequest {
  workflow_id: string;
  title: string;
  description: string;
  pattern?: string;
  mission_class: string;
  risk_profile: 'low' | 'review_required' | 'approval_required' | 'high_stakes';
  delivery_shape?: string;
  team_template: string;
  aliases?: string[];
  track?: { track_type?: string; default_lifecycle?: string; min_confidence_to_autostart?: number };
  intent: IntentSpec;
  lead_phases?: string[];
  phases: PhaseSpec[];
  gate_profile_gates?: { profile: string; gates: Json[] };
  governance_bodies?: Json[];
}

function abs(rel: string): string {
  return path.join(pathResolver.rootDir(), rel);
}

function readJson(rel: string): Json {
  return JSON.parse(safeReadFile(abs(rel)) as string) as Json;
}

function writeJson(rel: string, obj: unknown): void {
  safeWriteFile(abs(rel), `${JSON.stringify(obj, null, 2)}\n`);
}

function parseArgs(argv: string[]): { mode: 'propose' | 'apply'; request: string } {
  const out: { mode: 'propose' | 'apply'; request: string } = { mode: 'propose', request: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--request') out.request = argv[i + 1] ?? '';
    else if (a === '--apply') out.mode = 'apply';
    else if (a === '--propose') out.mode = 'propose';
  }
  return out;
}

function validateRequest(req: unknown): void {
  const schema = JSON.parse(safeReadFile(abs(SCHEMA_REL)) as string);
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const ok = validate(req);
  if (!ok) {
    const errors = (validate as unknown as { errors?: unknown }).errors;
    throw new Error(
      `Registration request failed schema validation:\n${JSON.stringify(errors, null, 2)}`
    );
  }
}

function gateCheck(
  kind: string,
  deliverable: string | undefined,
  phaseId: string,
  suffix: string
): Json {
  switch (kind) {
    case 'evidence_exists':
      return { kind, params: { path: deliverable } };
    case 'reviewer_approved':
      return { kind, params: { task_id: `${phaseId}-${suffix}` } };
    case 'deliverable_quality':
      return { kind, params: { path: deliverable, kind: 'doc', min_score: 0.7 } };
    case 'human_override':
    default:
      return { kind: 'human_override' };
  }
}

function buildTemplate(req: RegistrationRequest): Json {
  const phases: unknown[] = [];
  for (const lead of req.lead_phases ?? ['intake', 'classification']) phases.push(lead);

  for (const ph of req.phases) {
    if (ph.preflight_before) phases.push('preflight');
    const suffix = ph.id.replace(/_/g, '-');
    const isReview = ph.kind === 'review';
    const fallbackDescription = isReview
      ? `${ph.title}を実施し、レビュー結果と判定を記録する`
      : `${ph.title}を実施し、${ph.deliverable ?? '成果物'}に記録する`;
    const task: Json = {
      task_id_suffix: suffix,
      team_role: ph.team_role ?? (isReview ? 'reviewer' : 'implementer'),
      description:
        ph.description && ph.description.length >= 12 ? ph.description : fallbackDescription,
      acceptance_criteria:
        ph.acceptance_criteria && ph.acceptance_criteria.length > 0
          ? ph.acceptance_criteria
          : [`${ph.title} が完了している`],
      expected_output_format: isReview
        ? 'structured'
        : ph.deliverable_kind === 'doc'
          ? 'files'
          : 'structured',
      estimated_scope: ph.estimated_scope ?? 'M',
      risk: ph.risk ?? 'medium',
    };
    if (!isReview && ph.deliverable) task.deliverable = ph.deliverable;
    if (!isReview && ph.deliverable_kind) task.deliverable_kind = ph.deliverable_kind;
    if (isReview && ph.review_target_suffix) task.review_target_suffix = ph.review_target_suffix;

    const checks = ph.checks.map((c) => gateCheck(c, ph.deliverable, ph.id, suffix));
    const phaseObj: Json = {
      id: ph.id,
      title: ph.title,
      kind: ph.kind,
      default_tasks: [task],
      exit_gate: { id: ph.gate_id, checks },
    };
    if (ph.pipeline_ref) phaseObj.pipeline_ref = ph.pipeline_ref;
    phases.push(phaseObj);
  }

  return {
    id: req.workflow_id,
    pattern: req.pattern ?? 'stage_gated_delivery',
    description: req.description,
    match: {
      mission_classes: [req.mission_class],
      delivery_shapes: [req.delivery_shape ?? 'multi_artifact_pipeline'],
      intent_ids: [req.workflow_id, ...(req.aliases ?? [])],
    },
    phases,
  };
}

function buildIntent(req: RegistrationRequest): Json {
  return {
    id: req.workflow_id,
    category: 'outcome_execution',
    description: req.description,
    surface_examples: req.intent.surface_examples ?? [],
    plan_outline: req.intent.plan_outline ?? [],
    intake_requirements: req.intent.intake_requirements ?? [],
    outcome_ids: req.intent.outcome_ids,
    specialist_id: req.intent.specialist_id,
    trigger_keywords: req.intent.trigger_keywords,
    resolution: { shape: 'mission', result_shape: 'summary' },
    legacy_category: 'surface',
    exposed_to_surface: req.intent.exposed_to_surface ?? true,
    target: req.intent.target,
    action: req.intent.action,
    object: req.intent.object,
    execution_shape: 'mission',
    mission_class: req.mission_class,
    risk_profile: req.risk_profile,
  };
}

function buildOntology(req: RegistrationRequest): Json {
  return {
    intent_id: req.workflow_id,
    category: 'outcome_execution',
    legacy_category: 'surface',
    target: req.intent.target,
    action: req.intent.action,
    object: req.intent.object,
    exposed_to_surface: req.intent.exposed_to_surface ?? true,
    execution_shape: 'mission',
    mission_class: req.mission_class,
    workflow_template: req.workflow_id,
    team_template: req.team_template,
    risk_profile: req.risk_profile,
    outcome_ids: req.intent.outcome_ids,
    actuator_requirements: req.intent.actuator_requirements,
    readiness_required: ['kyberion-runtime-baseline', 'reasoning-backend'],
    evidence_required: ['artifact-record'],
    reasoning_requirements: {
      mode: 'multi_step_reasoning',
      capability_tags: ['multi_step_reasoning', 'structured_output'],
      fallback_allowed: false,
    },
  };
}

function upsertById(arr: unknown[], idKey: string, entry: Json): unknown[] {
  const id = entry[idKey];
  const filtered = arr.filter((e) => (e as Json)?.[idKey] !== id);
  filtered.push(entry);
  return filtered;
}

function applyToGovernedCatalogs(req: RegistrationRequest): string[] {
  const touched: string[] = [];

  // 1) mission-workflow-catalog: insert before the default template so it stays last.
  const catalog = readJson(CATALOG_REL);
  const templates = (catalog.templates as unknown[]) ?? [];
  const withoutMine = templates.filter((t) => (t as Json)?.id !== req.workflow_id);
  const defaultIdx = withoutMine.findIndex((t) => (t as Json)?.id === DEFAULT_WORKFLOW);
  const template = buildTemplate(req);
  if (defaultIdx >= 0) withoutMine.splice(defaultIdx, 0, template);
  else withoutMine.push(template);
  catalog.templates = withoutMine;
  writeJson(CATALOG_REL, catalog);
  touched.push(CATALOG_REL);

  // 2) standard-intents
  const intents = readJson(INTENTS_REL);
  intents.intents = upsertById((intents.intents as unknown[]) ?? [], 'id', buildIntent(req));
  writeJson(INTENTS_REL, intents);
  touched.push(INTENTS_REL);

  // 3) intent-domain-ontology
  const ontology = readJson(ONTOLOGY_REL);
  ontology.intents = upsertById(
    (ontology.intents as unknown[]) ?? [],
    'intent_id',
    buildOntology(req)
  );
  writeJson(ONTOLOGY_REL, ontology);
  touched.push(ONTOLOGY_REL);

  // 4) routing (track policy map) — optional
  if (req.track && req.track.track_type) {
    const routing = readJson(ROUTING_REL);
    const map = (routing.track_intent_policy_map as Json) ?? {};
    map[req.workflow_id] = {
      track_type: req.track.track_type,
      default_lifecycle: req.track.default_lifecycle ?? 'default-sdlc',
      min_confidence_to_autostart: req.track.min_confidence_to_autostart ?? 0.75,
    };
    routing.track_intent_policy_map = map;
    writeJson(ROUTING_REL, routing);
    touched.push(ROUTING_REL);
  }

  // 5) gate-profile gates — optional
  if (req.gate_profile_gates && req.gate_profile_gates.gates.length > 0) {
    const reg = readJson(GATE_PROFILES_REL);
    const profiles = (reg.profiles as Json) ?? {};
    const profile = (profiles[req.gate_profile_gates.profile] as Json) ?? {
      domain: 'delivery',
      gates: [],
    };
    const gates = (profile.gates as unknown[]) ?? [];
    for (const g of req.gate_profile_gates.gates) {
      const gid = (g as Json).gate_id;
      const idx = gates.findIndex((x) => (x as Json)?.gate_id === gid);
      if (idx >= 0) gates[idx] = g;
      else gates.push(g);
    }
    profile.gates = gates;
    profiles[req.gate_profile_gates.profile] = profile;
    reg.profiles = profiles;
    writeJson(GATE_PROFILES_REL, reg);
    touched.push(GATE_PROFILES_REL);
  }

  // 6) governance bodies — optional
  if (req.governance_bodies && req.governance_bodies.length > 0) {
    const reg = readJson(GOV_BODY_REL);
    let bodies = (reg.bodies as unknown[]) ?? [];
    for (const b of req.governance_bodies) bodies = upsertById(bodies, 'id', b as Json);
    reg.bodies = bodies;
    writeJson(GOV_BODY_REL, reg);
    touched.push(GOV_BODY_REL);
  }

  return touched;
}

function proposeBundle(req: RegistrationRequest): string {
  const dirRel = path.join(PROPOSALS_REL, req.workflow_id);
  safeMkdir(abs(dirRel));
  const write = (name: string, obj: unknown): void =>
    safeWriteFile(abs(path.join(dirRel, name)), `${JSON.stringify(obj, null, 2)}\n`);

  write('mission-workflow-catalog.template.json', buildTemplate(req));
  write('standard-intents.entry.json', buildIntent(req));
  write('intent-domain-ontology.entry.json', buildOntology(req));
  if (req.track?.track_type) {
    write('intent-routing-map.track.json', {
      [req.workflow_id]: {
        track_type: req.track.track_type,
        default_lifecycle: req.track.default_lifecycle ?? 'default-sdlc',
        min_confidence_to_autostart: req.track.min_confidence_to_autostart ?? 0.75,
      },
    });
  }
  if (req.gate_profile_gates) write('gate-profile.gates.json', req.gate_profile_gates);
  if (req.governance_bodies) write('governance-bodies.json', req.governance_bodies);

  const instructions = [
    `# Workflow registration proposal: ${req.workflow_id}`,
    '',
    'This is a ready-to-merge proposal bundle. Merge each fragment into its governed catalog,',
    'then run the validators to gate the change:',
    '',
    '- `mission-workflow-catalog.template.json` → append to `templates[]` (before `single-track-default`) in',
    '  `knowledge/product/governance/mission-workflow-catalog.json`',
    '- `standard-intents.entry.json` → append to `intents[]` in `standard-intents.json`',
    '- `intent-domain-ontology.entry.json` → append to `intents[]` in `intent-domain-ontology.json`',
    '- `intent-routing-map.track.json` → merge into `track_intent_policy_map` in `intent-routing-map.json`',
    '',
    'Then validate:',
    '```',
    'pnpm run build',
    'node dist/scripts/check_workflow_catalog_refs.js',
    'node dist/scripts/check_governance_rules.js',
    'node dist/scripts/check_intent_domain_coverage.js',
    'pnpm generate:knowledge-index',
    '```',
    '',
    'Or apply directly (governed write, authority role register_workflow):',
    '```',
    `node dist/scripts/register_workflow.js --request <this-request>.json --apply`,
    '```',
  ].join('\n');
  safeWriteFile(abs(path.join(dirRel, 'MERGE_INSTRUCTIONS.md')), `${instructions}\n`);

  return dirRel;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request) {
    process.stderr.write('Usage: register_workflow --request <path> [--propose|--apply]\n');
    process.exit(2);
    return;
  }

  const requestPath = path.isAbsolute(args.request) ? args.request : abs(args.request);
  const req = JSON.parse(safeReadFile(requestPath) as string) as RegistrationRequest;
  validateRequest(req);

  if (args.mode === 'apply') {
    const touched = applyToGovernedCatalogs(req);
    process.stdout.write(
      JSON.stringify(
        {
          mode: 'apply',
          workflow_id: req.workflow_id,
          touched,
          next: 'Run: pnpm run build && node dist/scripts/check_workflow_catalog_refs.js && node dist/scripts/check_governance_rules.js && node dist/scripts/check_intent_domain_coverage.js && pnpm generate:knowledge-index',
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const dirRel = proposeBundle(req);
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'propose',
        workflow_id: req.workflow_id,
        proposal_dir: dirRel,
        next: `Review ${dirRel}/MERGE_INSTRUCTIONS.md, then merge and validate, or re-run with --apply.`,
      },
      null,
      2
    ) + '\n'
  );
}

main();
