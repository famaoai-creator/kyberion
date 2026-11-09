import type { WorkItem } from '../workforce/work-coordination-types.js';
import { requestedExecutionShape } from '../dot/dot-requested-shape.js';
export const INFORMATION_ASSET_WORK_PIPELINE =
  'knowledge/product/pipeline-templates/information-asset-work.json';
import type {
  InformationAssetObservation,
  InformationAssetScope,
  InformationObject,
} from './types.js';
/** Server-owned binding carried by immutable Dot admission, never model input. */
export interface InformationAssetWorkBinding {
  version: 1;
  recipe_id: string;
  recipe_version: number;
  work_key: string;
  observation: Omit<
    InformationAssetObservation,
    'data' | 'source_url' | 'occurred_at' | 'observed_at'
  >;
}
export type InformationAssetRecipeAction =
  | 'classify'
  | 'prepare_reply'
  | 'extract_actions'
  | 'follow_up'
  | 'review'
  | 'review_update'
  | 'resolve_review'
  | 'investigate_ci'
  | 'triage_issue'
  | 'approve_issue'
  | 'resolve_overdue'
  | 'request_information';
export interface InformationIntakeRecipe {
  recipe_id: string;
  version: number;
  title: string;
  asset_type: string;
  event_types: string[];
  action: InformationAssetRecipeAction;
  completion: 'artifact_hash' | 'external_readback';
  requires_approval: boolean;
}
export type PreparedInformationWork =
  | { kind: 'artifact'; text: string }
  | { kind: 'service_action'; params: InformationObject }
  | { kind: 'waiting'; reason: string; recheck_at?: string; deadline?: string };
export interface InformationAssetWorkInput {
  workItemId: string;
  attemptId: string;
  leaseId: string;
  dotId: string;
  actorId: string;
}
export interface InformationAssetWorkOutcome {
  status:
    'completed' | 'waiting_approval' | 'waiting_counterpart' | 'needs_recheck' | 'unknown_effect';
  work_item_id: string;
  work_key: string;
  summary: string;
  artifact_ref?: string;
  evidence_sha256?: string;
  approval_request_id?: string;
  execution_receipt_id?: string;
  recheck_at?: string;
  deadline?: string;
}
export interface InformationAssetReadback {
  scope: InformationAssetScope;
  subject_id: string;
  change_id: string;
  /** Verified against a new capture, never the write response. */
  verified: boolean;
  evidence_sha256: string;
}

/** Strict parser for persisted trusted bindings; unknown keys are rejected. */
export function parseInformationAssetWorkBinding(value: unknown): InformationAssetWorkBinding {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 2048;
  const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).every((k) => keys.includes(k));
  const invalid = () => {
    throw new Error('[INFORMATION_WORK_BINDING] Invalid trusted work binding');
  };
  if (
    !object(value) ||
    !exact(value, ['version', 'recipe_id', 'recipe_version', 'work_key', 'observation']) ||
    value.version !== 1 ||
    !text(value.recipe_id) ||
    !Number.isSafeInteger(value.recipe_version) ||
    (value.recipe_version as number) < 1 ||
    !/^[a-f0-9]{64}$/.test(String(value.work_key))
  )
    return invalid();
  const ref = value.observation;
  if (
    !object(ref) ||
    !exact(ref, [
      'event_id',
      'scope',
      'asset_type',
      'location_id',
      'binding_id',
      'service_id',
      'subject_id',
      'change_id',
      'event_type',
      'content_sha256',
    ])
  )
    return invalid();
  for (const key of [
    'event_id',
    'asset_type',
    'location_id',
    'binding_id',
    'service_id',
    'subject_id',
    'change_id',
    'event_type',
  ])
    if (!text(ref[key])) return invalid();
  if (!/^[a-f0-9]{64}$/.test(String(ref.content_sha256))) return invalid();
  if (
    !object(ref.scope) ||
    !exact(ref.scope, ['tenant_slug', 'organization_id', 'project_id']) ||
    !text(ref.scope.tenant_slug) ||
    !text(ref.scope.organization_id) ||
    ('project_id' in ref.scope && !text(ref.scope.project_id))
  )
    return invalid();
  return structuredClone(value) as unknown as InformationAssetWorkBinding;
}

export interface InformationAssetMissionExecutionPlan {
  mission_id: string;
  work_item_id: string;
  dot_id: string;
  pipeline_ref: typeof INFORMATION_ASSET_WORK_PIPELINE;
  recipe_id: string;
  work_key: string;
}
/** Pure plan shared by the approved mission brief and the owner execution facade. */
export function buildInformationAssetMissionExecutionPlan(
  item: WorkItem,
  missionId: string
): InformationAssetMissionExecutionPlan {
  const binding = parseInformationAssetWorkBinding(item.metadata?.information_asset_work);
  if (
    requestedExecutionShape(item.metadata) !== 'mission' ||
    item.metadata.mission_id !== missionId ||
    typeof item.metadata.dot_id !== 'string' ||
    !item.metadata.mission_admission
  )
    throw new Error('[INFORMATION_MISSION_BINDING] Governed mission admission identity required');
  return {
    mission_id: missionId,
    work_item_id: item.item_id,
    dot_id: item.metadata.dot_id,
    pipeline_ref: INFORMATION_ASSET_WORK_PIPELINE,
    recipe_id: binding.recipe_id,
    work_key: binding.work_key,
  };
}
