import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  saveProjectTrackRecord,
  type ProjectTrackRecord,
} from './project-track-registry.js';
import { compileSchemaFromPath } from './schema-loader.js';

type JsonObject = Record<string, unknown>;

export interface TrackIntentPolicyMapping {
  track_type: string;
  default_lifecycle: string;
  min_confidence_to_autostart: number;
}

export interface TrackTypePolicy {
  description?: string;
  typical_lifecycle?: string;
  gate_profile?: string;
  entry_criteria?: string[];
  exit_criteria?: string[];
  recommended_pipeline?: string;
  mission_class?: string;
  tier?: 'personal' | 'confidential' | 'public';
  note?: string;
  [key: string]: unknown;
}

export interface TrackLifecyclePolicy {
  phases: string[];
  gates_per_phase: Record<string, string[]>;
  [key: string]: unknown;
}

export interface TrackPolicy {
  intent_id: string;
  mapping: TrackIntentPolicyMapping;
  track_type: string;
  lifecycle_model: string;
  track_type_policy: TrackTypePolicy;
  lifecycle_policy: TrackLifecyclePolicy;
  effective_policy: JsonObject;
  override_paths: string[];
}

export type IntentTrackGateResult =
  | {
      status: 'escalation_required';
      reason: 'low_confidence';
      intent_id: string;
      confidence: number;
      min_confidence_to_autostart: number;
    }
  | {
      status: 'ready_to_provision';
      confidence: number;
      policy: TrackPolicy;
      track_record: ProjectTrackRecord;
      relationship: {
        track: {
          relationship_type: 'belongs_to';
          track_id: string;
          track_name: string;
          track_type: ProjectTrackRecord['track_type'];
          lifecycle_model: ProjectTrackRecord['lifecycle_model'];
          traceability_refs: string[];
          note: string;
        };
      };
    };

export interface ResolveIntentTrackGateInput {
  intentId: string;
  confidence: number;
  tenantId?: string;
  targetTier?: 'personal' | 'confidential' | 'public';
  projectId?: string;
  missionId?: string;
  title?: string;
  summary?: string;
  persist?: boolean;
  overridePaths?: string[];
  confirmationReason?: string;
}

interface IntentRoutingMap {
  track_intent_policy_map?: Record<string, TrackIntentPolicyMapping>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
let overrideValidator: ValidateFunction | null = null;

function readJson(filePath: string): JsonObject {
  return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as JsonObject;
}

function ensureOverrideValidator(): ValidateFunction {
  if (overrideValidator) return overrideValidator;
  overrideValidator = compileSchemaFromPath(
    ajv,
    pathResolver.rootResolve('schemas/track-policy-override.schema.json'),
  );
  return overrideValidator;
}

function assertTrackPolicyShape(value: unknown, source: string): asserts value is JsonObject {
  const validate = ensureOverrideValidator();
  if (!validate(value)) {
    const detail = JSON.stringify(validate.errors || []);
    throw new Error(`Invalid track policy override at ${source}: ${detail}`);
  }
}

function mergeJson(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    return [...new Set([...base, ...override])];
  }
  if (
    base && override &&
    typeof base === 'object' &&
    typeof override === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const merged: JsonObject = { ...(base as JsonObject) };
    for (const [key, value] of Object.entries(override as JsonObject)) {
      merged[key] = key in merged ? mergeJson(merged[key], value) : value;
    }
    return merged;
  }
  return override;
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collectOverridePaths(
  tenantId?: string,
  targetTier: 'personal' | 'confidential' | 'public' = 'confidential',
  additionalOverridePaths: string[] = [],
): string[] {
  const paths: string[] = [];
  if (targetTier === 'personal') {
    paths.push(pathResolver.knowledge('personal/connections/track-policy-override.json'));
  }
  const tenant = sanitizePathSegment(String(tenantId || ''));
  if (tenant && targetTier !== 'public') {
    paths.push(pathResolver.knowledge(`confidential/${tenant}/governance/track-policy-override.json`));
  }
  paths.push(...additionalOverridePaths);
  return paths;
}

function normalizeProjectTrackType(trackType: string): ProjectTrackRecord['track_type'] {
  switch (trackType) {
    case 'delivery':
    case 'change':
    case 'release':
    case 'incident':
    case 'operations':
      return trackType;
    case 'governance':
    case 'engineering_governance':
    case 'operational_governance':
      return 'compliance';
    case 'product_discovery':
      return 'research';
    default:
      return 'delivery';
  }
}

function normalizeProjectLifecycle(lifecycle: string): ProjectTrackRecord['lifecycle_model'] {
  switch (lifecycle) {
    case 'incident-response':
      return 'incident_response';
    case 'ops-continuous':
      return 'continuous_operations';
    case 'discovery-sdlc':
      return 'research_cycle';
    case 'default-sdlc':
    case 'governance-sdlc':
    case 'release-sdlc':
    case 'change-control':
    default:
      return 'sdlc';
  }
}

function sanitizeIdFragment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function loadRoutingMap(): IntentRoutingMap {
  return readJson(pathResolver.knowledge('product/governance/intent-routing-map.json')) as IntentRoutingMap;
}

export async function resolveIntentToTrackPolicy(
  intentId: string,
  tenantId?: string,
  overridePaths: string[] = [],
  targetTier: 'personal' | 'confidential' | 'public' = 'confidential',
): Promise<TrackPolicy> {
  const normalizedIntentId = String(intentId || '').trim();
  if (!normalizedIntentId) throw new Error('intentId is required');

  const routing = loadRoutingMap();
  const mapping = routing.track_intent_policy_map?.[normalizedIntentId];
  if (!mapping) {
    throw new Error(`No track intent policy mapping for intent: ${normalizedIntentId}`);
  }

  const globalPath = pathResolver.knowledge('product/governance/track-creation-policy.json');
  const globalPolicy = readJson(globalPath);
  assertTrackPolicyShape(globalPolicy, globalPath);

  let effectivePolicy: JsonObject = globalPolicy;
  const appliedOverridePaths: string[] = [];
  for (const candidate of collectOverridePaths(tenantId, targetTier, overridePaths)) {
    if (!safeExistsSync(candidate)) continue;
    const override = readJson(candidate);
    assertTrackPolicyShape(override, candidate);
    effectivePolicy = mergeJson(effectivePolicy, override) as JsonObject;
    appliedOverridePaths.push(candidate);
  }
  assertTrackPolicyShape(effectivePolicy, 'effective track policy');

  const trackTypes = effectivePolicy.track_types as Record<string, TrackTypePolicy> | undefined;
  const lifecycleModels = effectivePolicy.lifecycle_models as Record<string, TrackLifecyclePolicy> | undefined;
  const trackTypePolicy = trackTypes?.[mapping.track_type];
  if (!trackTypePolicy) throw new Error(`Track type policy not found: ${mapping.track_type}`);

  const lifecycleModel = mapping.default_lifecycle || trackTypePolicy.typical_lifecycle;
  const lifecyclePolicy = lifecycleModel ? lifecycleModels?.[lifecycleModel] : undefined;
  if (!lifecycleModel || !lifecyclePolicy) throw new Error(`Lifecycle policy not found: ${lifecycleModel || '(empty)'}`);

  return {
    intent_id: normalizedIntentId,
    mapping,
    track_type: mapping.track_type,
    lifecycle_model: lifecycleModel,
    track_type_policy: trackTypePolicy,
    lifecycle_policy: lifecyclePolicy,
    effective_policy: effectivePolicy,
    override_paths: appliedOverridePaths,
  };
}

export function buildProjectTrackRecordFromPolicy(input: {
  policy: TrackPolicy;
  confidence: number;
  projectId?: string;
  missionId?: string;
  title?: string;
  summary?: string;
  confirmationReason?: string;
}): ProjectTrackRecord {
  const projectId = input.projectId?.trim() || `PRJ-${sanitizeIdFragment(input.policy.intent_id, 'INTENT')}`;
  const trackId = `TRK-${sanitizeIdFragment(projectId.replace(/^PRJ-/, ''), 'PROJECT')}-${sanitizeIdFragment(input.policy.track_type, 'TRACK')}`;
  const trackType = normalizeProjectTrackType(input.policy.track_type);
  const lifecycleModel = normalizeProjectLifecycle(input.policy.lifecycle_model);

  return {
    track_id: trackId,
    project_id: projectId,
    name: input.title?.trim() || `${input.policy.track_type} track for ${input.policy.intent_id}`,
    summary: input.summary?.trim() || input.policy.track_type_policy.description || `Intent-provisioned track for ${input.policy.intent_id}.`,
    status: 'active',
    track_type: trackType,
    lifecycle_model: lifecycleModel,
    tier: input.policy.track_type_policy.tier || 'confidential',
    gate_profile_id: input.policy.track_type_policy.gate_profile,
    active_missions: input.missionId ? [input.missionId.toUpperCase()] : [],
    required_artifacts: Object.values(input.policy.lifecycle_policy.gates_per_phase || {}).flat(),
    metadata: {
      intent_id: input.policy.intent_id,
      confidence: input.confidence,
      confidence_gate_confirmation: input.confirmationReason,
      logical_track_type: input.policy.track_type,
      logical_lifecycle_model: input.policy.lifecycle_model,
      lifecycle_phases: input.policy.lifecycle_policy.phases,
      gates_per_phase: input.policy.lifecycle_policy.gates_per_phase,
    },
  };
}

export async function resolveIntentTrackGate(input: ResolveIntentTrackGateInput): Promise<IntentTrackGateResult> {
  const policy = await resolveIntentToTrackPolicy(
    input.intentId,
    input.tenantId,
    input.overridePaths,
    input.targetTier,
  );
  const confirmationReason = input.confirmationReason?.trim();
  if (input.confidence < policy.mapping.min_confidence_to_autostart && !confirmationReason) {
    return {
      status: 'escalation_required',
      reason: 'low_confidence',
      intent_id: policy.intent_id,
      confidence: input.confidence,
      min_confidence_to_autostart: policy.mapping.min_confidence_to_autostart,
    };
  }

  const trackRecord = buildProjectTrackRecordFromPolicy({
    policy,
    confidence: input.confidence,
    projectId: input.projectId,
    missionId: input.missionId,
    title: input.title,
    summary: input.summary,
    confirmationReason,
  });
  if (input.persist !== false) {
    saveProjectTrackRecord(trackRecord);
  }

  return {
    status: 'ready_to_provision',
    confidence: input.confidence,
    policy,
    track_record: trackRecord,
    relationship: {
      track: {
        relationship_type: 'belongs_to',
        track_id: trackRecord.track_id,
        track_name: trackRecord.name,
        track_type: trackRecord.track_type,
        lifecycle_model: trackRecord.lifecycle_model,
        traceability_refs: [`intent:${policy.intent_id}`, `policy-lifecycle:${policy.lifecycle_model}`],
        note: confirmationReason
          ? `Intent-to-track gate confirmed below threshold with confidence ${input.confidence}.`
          : `Intent-to-track gate passed with confidence ${input.confidence}.`,
      },
    },
  };
}
