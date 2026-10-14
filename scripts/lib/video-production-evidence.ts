import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineCatalog } from '@agent/core/foundation';
import { parseSafeJsonObjectInput } from '@agent/core/foundation/safe-json';
import { pathResolver, findMissionPath } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeStat,
  safeRealpath,
  safeReadFileRange,
  safeWriteFile,
} from '@agent/core/secure-io';
import { normalizeEventScope, type EventScope } from '@agent/core/event-scope';
import { loadMissionStateAtPath } from '@agent/core/mission/mission-state-reader';
import { resolveMissionTeamSelectionScope } from '@agent/core/mission/mission-team-selection';
import {
  assertApprovalUsable,
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';

export const VIDEO_APPROVAL_CHANNEL = 'video-production';
export const VIDEO_PRODUCTION_STAGES = [
  'spec',
  'plan',
  'prototypes',
  'generation',
  'assets',
  'repair',
  'render',
  'final',
] as const;
export type VideoProductionStage = (typeof VIDEO_PRODUCTION_STAGES)[number];
export interface VideoMission {
  id: string;
  dir: string;
  scope: EventScope;
}
export interface ArtifactRef {
  path: string;
  sha256: string;
}
export interface VideoProductionSpec {
  kind: 'video-production-spec';
  duration_sec: number;
  budget: {
    unit: string;
    cap: number;
    available: number;
    base_cost: number;
    max_repair_rounds: number;
  };
}
export interface VideoScene {
  scene_id: string;
  duration_sec: number;
  message: string;
  narration: string;
  visual: string;
  overlay: string;
  audio: string;
  generation: {
    mode: 'none' | 'text_only' | 'reference_image';
    max_attempts: number;
    cost_per_attempt: number;
    quote_source: string;
    quoted_at: string;
  };
  quality_criteria: string[];
  action_cues: Array<{ time_sec: number; action: string }>;
  audio_cues: Array<{ time_sec: number; cue: string }>;
}
export interface VideoScenePlan {
  kind: 'video-scene-plan';
  scenes: VideoScene[];
}
export interface VideoPrototype {
  scene_id: string;
  revision: number;
  artifact: ArtifactRef;
}
export interface VideoPrototypeManifest {
  kind: 'video-prototype-manifest';
  references: VideoPrototype[];
}
export interface VideoPrototypeAcceptance {
  kind: 'video-prototype-acceptance';
  requests: Array<{ scene_id: string; request_id: string }>;
}
export interface VideoAsset {
  scene_id: string;
  status: 'ready' | 'failed' | 'pending';
  generation_mode: VideoScene['generation']['mode'];
  selected_take?: ArtifactRef;
  source_reference?: ArtifactRef;
  job_id?: string;
  generation_contract?: ArtifactRef;
  scene_plan_hash: string;
  attempt_count: number;
  repair_count: number;
  spent: number;
  reason?: string;
}
export interface VideoAssetManifest {
  kind: 'video-asset-manifest';
  unit: string;
  base_spent: number;
  assets: VideoAsset[];
}
export interface VideoEvaluation {
  kind: 'video-eval-report';
  verdict: 'pass' | 'repair';
  flags: Array<{ scene_id: string; reason: string }>;
  repair_rounds: number;
  evaluated_render: ArtifactRef;
  scene_plan_sha256: string;
  scene_reviews: Array<{
    scene_id: string;
    selected_take_sha256: string;
    criteria_checked: string[];
  }>;
}
export interface VideoPlaybackApproval {
  kind: 'video-playback-approval';
  request_id?: string;
  not_required?: boolean;
}
type Evidence =
  | VideoProductionSpec
  | VideoScenePlan
  | VideoPrototypeManifest
  | VideoPrototypeAcceptance
  | VideoAssetManifest
  | VideoEvaluation
  | VideoPlaybackApproval;

function requireCondition(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function resolveVideoMission(idInput: string): VideoMission {
  const id = idInput.trim().toUpperCase();
  const dir = findMissionPath(id);
  requireCondition(dir, 'Video mission was not found.');
  const state = loadMissionStateAtPath(path.join(dir, 'mission-state.json'));
  requireCondition(
    state && state.mission_id.toUpperCase() === id,
    'Canonical video mission state is missing or invalid.'
  );
  return {
    id,
    dir,
    scope: normalizeEventScope({
      ...resolveMissionTeamSelectionScope(state),
      tier: state.tier,
      mission_id: id,
      scope_kind: 'mission',
    }),
  };
}

/** Evidence references are confined to this mission, including their canonical targets. */
export function videoEvidencePath(mission: VideoMission, relative: string, exists = true): string {
  requireCondition(
    relative.startsWith('evidence/') &&
      !relative.includes('\\') &&
      !relative.includes('\0') &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Video evidence must be a mission-relative path under evidence/.'
  );
  const file = assertSafeRepositoryPath(path.join(mission.dir, relative), {
    allowMissingLeaf: !exists,
  });
  if (exists) {
    requireCondition(
      safeExistsSync(file) && safeLstat(file).isFile(),
      'Video evidence must be a regular file: ' + relative
    );
    const canonicalRelative = path.relative(safeRealpath(mission.dir), safeRealpath(file));
    requireCondition(
      !path.isAbsolute(canonicalRelative) &&
        canonicalRelative !== '..' &&
        !canonicalRelative.startsWith('..' + path.sep),
      'Video evidence leaves its mission scope.'
    );
  }
  return file;
}

export function videoArtifactDigest(mission: VideoMission, relative: string): string {
  const file = videoEvidencePath(mission, relative);
  const before = safeStat(file);
  requireCondition(before.size > 0, 'Video artifact is empty.');
  const hash = createHash('sha256');
  for (let offset = 0; offset < before.size; offset += 1024 * 1024) {
    hash.update(safeReadFileRange(file, offset, Math.min(1024 * 1024, before.size - offset)));
  }
  const after = safeStat(file);
  requireCondition(
    before.size === after.size && before.mtimeMs === after.mtimeMs,
    'Video artifact changed during verification.'
  );
  return hash.digest('hex');
}

function checkArtifact(mission: VideoMission, ref: ArtifactRef): void {
  requireCondition(
    videoArtifactDigest(mission, ref.path) === ref.sha256,
    'Video artifact digest does not match: ' + ref.path
  );
}

function readEvidence<T extends Evidence>(mission: VideoMission, file: string, kind: T['kind']): T {
  const value = defineCatalog<Evidence>({
    id: 'video-production-evidence',
    path: videoEvidencePath(mission, 'evidence/' + file),
    schema: pathResolver.knowledge('product/schemas/video-production-evidence.schema.json'),
  }).load();
  requireCondition(value.kind === kind, 'Wrong video evidence kind: ' + file);
  return value as T;
}

function byScene<T extends { scene_id: string }>(entries: T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    requireCondition(
      !result.has(entry.scene_id),
      'Duplicate scene in ' + label + ': ' + entry.scene_id
    );
    result.set(entry.scene_id, entry);
  }
  return result;
}

function checkedSpec(mission: VideoMission): VideoProductionSpec {
  const spec = readEvidence<VideoProductionSpec>(
    mission,
    'production-spec.json',
    'video-production-spec'
  );
  requireCondition(
    spec.budget.cap <= spec.budget.available,
    'Video budget cap exceeds available allowance.'
  );
  requireCondition(
    spec.budget.base_cost <= spec.budget.cap,
    'Base production cost exceeds the cap.'
  );
  return spec;
}

function checkedPlan(mission: VideoMission, spec: VideoProductionSpec): VideoScenePlan {
  const plan = readEvidence<VideoScenePlan>(mission, 'scene-plan.json', 'video-scene-plan');
  byScene(plan.scenes, 'scene plan');
  let estimate = spec.budget.base_cost;
  let duration = 0;
  for (const scene of plan.scenes) {
    duration += scene.duration_sec;
    requireCondition(
      scene.action_cues.every((cue) => cue.time_sec <= scene.duration_sec) &&
        scene.audio_cues.every((cue) => cue.time_sec <= scene.duration_sec),
      'Scene cue is outside its duration: ' + scene.scene_id
    );
    requireCondition(
      Date.parse(scene.generation.quoted_at) <= Date.now() + 300_000,
      'Generation quote is dated in the future.'
    );
    if (scene.generation.mode === 'none') {
      requireCondition(
        scene.generation.cost_per_attempt === 0,
        'A non-generated scene must not carry generation cost.'
      );
    } else {
      requireCondition(
        scene.generation.max_attempts <= 1 + spec.budget.max_repair_rounds,
        'Scene attempt cap exceeds initial generation plus allowed repairs.'
      );
      estimate += scene.generation.cost_per_attempt * scene.generation.max_attempts;
    }
  }
  requireCondition(
    Number.isFinite(estimate) && estimate <= spec.budget.cap,
    'Planned initial and retake costs exceed the video budget cap.'
  );
  requireCondition(
    Math.abs(duration - spec.duration_sec) <= 0.05,
    'Scene durations do not match the production spec.'
  );
  return plan;
}

function checkedPrototypes(mission: VideoMission, plan: VideoScenePlan): VideoPrototypeManifest {
  const prototypes = readEvidence<VideoPrototypeManifest>(
    mission,
    'prototype-manifest.json',
    'video-prototype-manifest'
  );
  const refs = byScene(prototypes.references, 'prototype manifest');
  const expected = plan.scenes.filter((scene) => scene.generation.mode === 'reference_image');
  requireCondition(
    refs.size === expected.length && expected.every((scene) => refs.has(scene.scene_id)),
    'Prototype references must exactly cover reference-image scenes.'
  );
  for (const prototype of refs.values()) checkArtifact(mission, prototype.artifact);
  return prototypes;
}

function prototypePayload(
  mission: VideoMission,
  plan: VideoScenePlan,
  prototypes: VideoPrototypeManifest
): Record<string, unknown> {
  const scenes = byScene(plan.scenes, 'scene plan');
  return {
    kind: 'video-prototype-review',
    mission_id: mission.id,
    prototypes: prototypes.references
      .map((ref) => ({
        ...ref,
        visual: scenes.get(ref.scene_id)!.visual,
      }))
      .sort((a, b) => a.scene_id.localeCompare(b.scene_id)),
  };
}

function effect(mission: VideoMission, kind: 'prototypes' | 'playback'): string {
  return 'video-production:' + mission.id + ':' + kind;
}

function scopeMatches(mission: VideoMission, record: ApprovalRequestRecord): boolean {
  return (
    ['tier', 'tenant_slug', 'organization_id', 'project_id', 'mission_id', 'scope_kind'] as const
  ).every((key) => record.scope?.[key] === mission.scope[key]);
}

function checkedApproval(
  mission: VideoMission,
  requestId: string,
  kind: 'prototypes' | 'playback'
): Record<string, unknown> {
  const record = loadApprovalRequest(VIDEO_APPROVAL_CHANNEL, requestId);
  requireCondition(
    record &&
      record.kind === 'mission_gate' &&
      record.status === 'approved' &&
      record.source?.missionId === mission.id &&
      scopeMatches(mission, record),
    'A current human video approval is required.'
  );
  requireCondition(!isApprovalRequestExpired(record), 'Video approval expired.');
  requireCondition(
    record.decidedByIdentitySource === 'server_resolved' &&
      ['surface_session', 'terminal_attested', 'totp', 'passkey'].includes(
        record.decidedAuthMethod || ''
      ),
    'Video acceptance needs a server-identified human decision.'
  );
  assertApprovalUsable(record, { consumer: 'video_production' });
  requireCondition(
    record.accountability?.finalDecision === 'human_only' &&
      record.accountability.effectBinding === effect(mission, kind),
    'Video approval has the wrong effect binding.'
  );
  const payload = parseSafeJsonObjectInput(record.sourceText || '', 'video approval payload');
  requireCondition(
    payload && payload.mission_id === mission.id,
    'Video approval payload is invalid.'
  );
  const hash = computeApprovalPayloadHash(payload);
  validateHumanFinalDecision({
    accountability: record.accountability,
    decidedByType: record.decidedByType,
    authenticated: record.authenticated,
    authMethod: record.decidedAuthMethod,
    payloadHash: hash,
    effectBinding: effect(mission, kind),
    phase: 'recheck',
  });
  requireCondition(
    record.accountability.payloadHash === hash,
    'Video approval payload hash is missing or changed.'
  );
  return payload;
}

function checkedAcceptance(
  mission: VideoMission,
  plan: VideoScenePlan,
  prototypes: VideoPrototypeManifest
): void {
  const acceptance = readEvidence<VideoPrototypeAcceptance>(
    mission,
    'prototype-acceptance.json',
    'video-prototype-acceptance'
  );
  const requests = byScene(acceptance.requests, 'prototype acceptance');
  const expected = prototypePayload(mission, plan, prototypes).prototypes as Array<
    Record<string, unknown>
  >;
  requireCondition(
    requests.size === expected.length &&
      expected.every((ref) => requests.has(String(ref.scene_id))),
    'Prototype acceptance must cover exactly the current reference scenes.'
  );
  for (const ref of expected) {
    const payload = checkedApproval(
      mission,
      requests.get(String(ref.scene_id))!.request_id,
      'prototypes'
    );
    requireCondition(
      payload.kind === 'video-prototype-review' &&
        Array.isArray(payload.prototypes) &&
        payload.prototypes.some(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            computeApprovalPayloadHash(entry as Record<string, unknown>) ===
              computeApprovalPayloadHash(ref)
        ),
      'Prototype approval does not cover this image revision and visual intent.'
    );
  }
}

function checkedAssets(
  mission: VideoMission,
  spec: VideoProductionSpec,
  plan: VideoScenePlan,
  prototypes: VideoPrototypeManifest,
  ready = true
): VideoAssetManifest {
  const manifest = readEvidence<VideoAssetManifest>(
    mission,
    'asset-manifest.json',
    'video-asset-manifest'
  );
  const assets = byScene(manifest.assets, 'asset manifest');
  const scenes = byScene(plan.scenes, 'scene plan');
  const refs = byScene(prototypes.references, 'prototypes');
  requireCondition(
    manifest.unit === spec.budget.unit,
    'Video spend unit does not match its budget.'
  );
  requireCondition(
    [...assets.keys()].every((id) => scenes.has(id)) && (!ready || assets.size === scenes.size),
    'Asset manifest has missing or unknown scenes.'
  );
  let spent = manifest.base_spent;
  for (const asset of assets.values()) {
    const scene = scenes.get(asset.scene_id)!;
    spent += asset.spent;
    requireCondition(
      asset.generation_mode === scene.generation.mode,
      'Asset generation mode changed: ' + asset.scene_id
    );
    requireCondition(
      asset.attempt_count <= scene.generation.max_attempts &&
        asset.repair_count <= spec.budget.max_repair_rounds,
      'Scene attempts or repair rounds exhausted: ' + asset.scene_id
    );
    if (scene.generation.mode === 'none') {
      requireCondition(
        asset.attempt_count === 0 && asset.repair_count === 0 && asset.spent === 0,
        'Non-generated assets must not claim generation attempts or spend.'
      );
    } else {
      requireCondition(
        asset.attempt_count === 0
          ? asset.repair_count === 0
          : asset.attempt_count >= 1 + asset.repair_count,
        'Generated asset has inconsistent initial and repair attempt history.'
      );
    }
    requireCondition(
      !ready || asset.status === 'ready',
      'A required scene asset is not ready: ' + asset.scene_id
    );
    if (asset.status !== 'ready') {
      requireCondition(
        asset.status !== 'failed' || asset.reason?.trim(),
        'Failed asset needs a repair reason.'
      );
      continue;
    }
    requireCondition(
      asset.scene_plan_hash ===
        computeApprovalPayloadHash(scene as unknown as Record<string, unknown>),
      'Selected take is bound to an old scene plan: ' + asset.scene_id
    );
    requireCondition(asset.selected_take, 'Selected take is missing: ' + asset.scene_id);
    checkArtifact(mission, asset.selected_take);
    if (scene.generation.mode === 'none') {
      requireCondition(
        asset.attempt_count === 0 && asset.repair_count === 0 && asset.spent === 0,
        'Non-generated assets must not claim generation attempts or spend.'
      );
    } else {
      requireCondition(
        asset.job_id && asset.generation_contract && asset.attempt_count >= 1 + asset.repair_count,
        'Generated asset lacks its job, contract or attempt history.'
      );
      checkArtifact(mission, asset.generation_contract);
      defineCatalog({
        id: 'video-generation-contract-evidence',
        path: videoEvidencePath(mission, asset.generation_contract.path),
        schema: pathResolver.knowledge('product/schemas/video-generation-adf.schema.json'),
      }).load();
    }
    if (scene.generation.mode === 'reference_image') {
      const ref = refs.get(asset.scene_id)!;
      requireCondition(
        asset.source_reference &&
          asset.source_reference.path === ref.artifact.path &&
          asset.source_reference.sha256 === ref.artifact.sha256,
        'Selected take refers to an old or different source image.'
      );
    }
  }
  requireCondition(
    Number.isFinite(spent) && spent <= spec.budget.cap,
    'Recorded video spend exceeds the cap.'
  );
  return manifest;
}

function checkedEvaluation(
  mission: VideoMission,
  spec: VideoProductionSpec,
  plan: VideoScenePlan,
  assets: VideoAssetManifest
): VideoEvaluation {
  const report = readEvidence<VideoEvaluation>(
    mission,
    'video-eval-report.json',
    'video-eval-report'
  );
  const scenes = byScene(plan.scenes, 'scene plan');
  const reviews = byScene(report.scene_reviews, 'scene reviews');
  const selected = byScene(assets.assets, 'selected assets');
  requireCondition(
    reviews.size === scenes.size && [...reviews.keys()].every((id) => scenes.has(id)),
    'Every current scene needs evaluation.'
  );
  requireCondition(
    report.repair_rounds <= spec.budget.max_repair_rounds &&
      assets.assets.every((asset) => asset.repair_count <= report.repair_rounds),
    'Evaluation repair rounds are inconsistent with the generation history.'
  );
  requireCondition(
    report.scene_plan_sha256 === videoArtifactDigest(mission, 'evidence/scene-plan.json'),
    'Evaluation is bound to an old scene plan.'
  );
  requireCondition(
    report.evaluated_render.path === 'evidence/draft-video.mp4' ||
      report.evaluated_render.path === 'evidence/final-video.mp4',
    'Evaluation must target the draft or final composed video.'
  );
  checkArtifact(mission, report.evaluated_render);
  for (const scene of plan.scenes) {
    const review = reviews.get(scene.scene_id)!;
    requireCondition(
      review.selected_take_sha256 === selected.get(scene.scene_id)!.selected_take!.sha256,
      'Evaluation is bound to an old selected take: ' + scene.scene_id
    );
    requireCondition(
      scene.quality_criteria.every((criterion) => review.criteria_checked.includes(criterion)),
      'Genre-specific review criteria are missing: ' + scene.scene_id
    );
  }
  requireCondition(
    report.flags.every((flag) => scenes.has(flag.scene_id)),
    'Evaluation flags reference unknown scenes.'
  );
  requireCondition(
    (report.verdict === 'pass') === (report.flags.length === 0),
    'Evaluation verdict and flags disagree.'
  );
  return report;
}

function playbackPayload(mission: VideoMission, report: VideoEvaluation): Record<string, unknown> {
  return {
    kind: 'video-playback-review',
    mission_id: mission.id,
    render: report.evaluated_render,
    evaluation_sha256: videoArtifactDigest(mission, 'evidence/video-eval-report.json'),
    full_playback_with_sound: true,
  };
}

export function checkVideoProductionEvidence(
  mission: VideoMission,
  stage: VideoProductionStage
): { stage: VideoProductionStage; passed: true } {
  requireCondition(
    (VIDEO_PRODUCTION_STAGES as readonly string[]).includes(stage),
    'Unknown video production stage.'
  );
  const spec = checkedSpec(mission);
  if (stage === 'spec') return { stage, passed: true };
  const plan = checkedPlan(mission, spec);
  if (stage === 'plan') return { stage, passed: true };
  const prototypes = checkedPrototypes(mission, plan);
  if (stage === 'prototypes') return { stage, passed: true };
  checkedAcceptance(mission, plan, prototypes);
  if (stage === 'generation') {
    if (safeExistsSync(videoEvidencePath(mission, 'evidence/asset-manifest.json', false))) {
      const existing = checkedAssets(mission, spec, plan, prototypes, false);
      const consumed =
        existing.base_spent + existing.assets.reduce((sum, asset) => sum + asset.spent, 0);
      let nextCost = 0;
      for (const scene of plan.scenes.filter((scene) => scene.generation.mode !== 'none')) {
        const asset = existing.assets.find((entry) => entry.scene_id === scene.scene_id);
        if (asset?.status === 'ready') continue;
        if ((asset?.attempt_count ?? 0) > 0) {
          requireCondition(
            (asset?.repair_count ?? 0) < spec.budget.max_repair_rounds,
            'No repair round allowance remains for generation.'
          );
        }
        requireCondition(
          (asset?.attempt_count ?? 0) < scene.generation.max_attempts,
          'No attempt allowance remains for generation.'
        );
        nextCost += scene.generation.cost_per_attempt;
      }
      requireCondition(
        nextCost <= spec.budget.cap - consumed,
        'No budget allowance remains for generation.'
      );
    }
    return { stage, passed: true };
  }
  const assets = checkedAssets(mission, spec, plan, prototypes);
  if (stage === 'assets') return { stage, passed: true };
  const report = checkedEvaluation(mission, spec, plan, assets);
  if (stage === 'repair') {
    if (report.verdict === 'repair') {
      requireCondition(
        report.repair_rounds < spec.budget.max_repair_rounds,
        'Video repair round limit reached.'
      );
      const flagged = new Set(report.flags.map((flag) => flag.scene_id));
      const consumed =
        assets.base_spent + assets.assets.reduce((sum, asset) => sum + asset.spent, 0);
      let nextCost = 0;
      for (const scene of plan.scenes.filter((entry) => flagged.has(entry.scene_id))) {
        const asset = assets.assets.find((entry) => entry.scene_id === scene.scene_id)!;
        if (scene.generation.mode !== 'none') {
          requireCondition(
            asset.attempt_count < scene.generation.max_attempts,
            'Flagged scene has exhausted its generation attempts.'
          );
          nextCost += scene.generation.cost_per_attempt;
        }
      }
      requireCondition(
        nextCost <= spec.budget.cap - consumed,
        'No budget remains for the flagged scenes.'
      );
    }
    return { stage, passed: true };
  }
  requireCondition(
    report.verdict === 'pass' &&
      report.flags.length === 0 &&
      report.evaluated_render.path === 'evidence/final-video.mp4',
    'Final video must have a passing evaluation of the current composed render.'
  );
  if (stage === 'render') return { stage, passed: true };
  const playback = readEvidence<VideoPlaybackApproval>(
    mission,
    'video-playback-approval.json',
    'video-playback-approval'
  );
  if (plan.scenes.some((scene) => scene.generation.mode !== 'none')) {
    requireCondition(
      playback.request_id && playback.not_required !== true,
      'Human full playback and listening approval is required.'
    );
    const payload = checkedApproval(mission, playback.request_id, 'playback');
    requireCondition(
      computeApprovalPayloadHash(payload) ===
        computeApprovalPayloadHash(playbackPayload(mission, report)),
      'Playback approval is bound to an old render or evaluation.'
    );
  } else {
    requireCondition(
      playback.not_required === true && !playback.request_id,
      'Non-generated playback must record the explicit pass-through.'
    );
  }
  return { stage, passed: true };
}

/** Explicit request command only. Never called by a read-only phase gate. */
export function requestVideoProductionApproval(
  mission: VideoMission,
  kind: 'prototypes' | 'playback'
): { request_ids: string[]; not_required: boolean; artifact_path: string } {
  requireCondition(kind === 'prototypes' || kind === 'playback', 'Unknown video approval kind.');
  checkVideoProductionEvidence(mission, kind === 'prototypes' ? 'prototypes' : 'render');
  const spec = checkedSpec(mission);
  const plan = checkedPlan(mission, spec);
  const prototypes = checkedPrototypes(mission, plan);
  if (kind === 'prototypes' && prototypes.references.length === 0) {
    safeWriteFile(
      videoEvidencePath(mission, 'evidence/prototype-approval-requests.json', false),
      JSON.stringify({ kind: 'video-prototype-acceptance', requests: [] }, null, 2) + '\n'
    );
    return {
      request_ids: [],
      not_required: true,
      artifact_path: 'evidence/prototype-approval-requests.json',
    };
  }
  if (kind === 'playback' && plan.scenes.every((scene) => scene.generation.mode === 'none')) {
    safeWriteFile(
      videoEvidencePath(mission, 'evidence/playback-approval-request.json', false),
      JSON.stringify({ kind: 'video-playback-approval', not_required: true }, null, 2) + '\n'
    );
    return {
      request_ids: [],
      not_required: true,
      artifact_path: 'evidence/playback-approval-request.json',
    };
  }
  const assets = kind === 'playback' ? checkedAssets(mission, spec, plan, prototypes) : undefined;
  const report = assets ? checkedEvaluation(mission, spec, plan, assets) : undefined;
  const preserved: VideoPrototypeAcceptance['requests'] = [];
  if (
    kind === 'prototypes' &&
    safeExistsSync(videoEvidencePath(mission, 'evidence/prototype-acceptance.json', false))
  ) {
    const previous = readEvidence<VideoPrototypeAcceptance>(
      mission,
      'prototype-acceptance.json',
      'video-prototype-acceptance'
    );
    const previousRequests = byScene(previous.requests, 'prototype acceptance');
    const expected = prototypePayload(mission, plan, prototypes).prototypes as Array<
      Record<string, unknown>
    >;
    for (const entry of expected) {
      const old = previousRequests.get(String(entry.scene_id));
      if (!old) continue;
      try {
        const accepted = checkedApproval(mission, old.request_id, 'prototypes');
        if (
          accepted.kind === 'video-prototype-review' &&
          Array.isArray(accepted.prototypes) &&
          accepted.prototypes.some(
            (item) =>
              item &&
              typeof item === 'object' &&
              computeApprovalPayloadHash(item as Record<string, unknown>) ===
                computeApprovalPayloadHash(entry)
          )
        ) {
          preserved.push(old);
        }
      } catch {
        /* Changed, expired or unusable approval needs a fresh decision. */
      }
    }
  }
  const pending = {
    ...prototypes,
    references: prototypes.references.filter(
      (ref) => !preserved.some((old) => old.scene_id === ref.scene_id)
    ),
  };
  if (kind === 'prototypes' && pending.references.length === 0) {
    safeWriteFile(
      videoEvidencePath(mission, 'evidence/prototype-approval-requests.json', false),
      JSON.stringify({ kind: 'video-prototype-acceptance', requests: preserved }, null, 2) + '\n'
    );
    return {
      request_ids: [...new Set(preserved.map((ref) => ref.request_id))],
      not_required: false,
      artifact_path: 'evidence/prototype-approval-requests.json',
    };
  }
  const payload = report
    ? playbackPayload(mission, report)
    : prototypePayload(mission, plan, pending);
  const hash = computeApprovalPayloadHash(payload);
  const current = listApprovalRequests({
    storageChannels: [VIDEO_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
    scope: mission.scope,
  }).find(
    (record) =>
      record.source?.missionId === mission.id &&
      scopeMatches(mission, record) &&
      record.accountability?.payloadHash === hash &&
      record.accountability.effectBinding === effect(mission, kind) &&
      !isApprovalRequestExpired(record) &&
      (record.status !== 'approved' ||
        (() => {
          try {
            checkedApproval(mission, record.id, kind);
            return true;
          } catch {
            return false;
          }
        })())
  );
  const record =
    current ??
    createApprovalRequest('mission_controller', {
      channel: VIDEO_APPROVAL_CHANNEL,
      storageChannel: VIDEO_APPROVAL_CHANNEL,
      threadTs: mission.id,
      correlationId: effect(mission, kind) + ':' + hash,
      requestedBy: 'agent:video-production',
      kind: 'mission_gate',
      source: { missionId: mission.id },
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      scope: mission.scope,
      sourceText: JSON.stringify(payload),
      draft: {
        title:
          kind === 'prototypes'
            ? 'Accept video prototype images'
            : 'Accept complete video playback',
        summary:
          kind === 'prototypes'
            ? 'Review the exact starting images before generating dependent footage.'
            : 'Play the complete final video with sound and accept its visual continuity and intelligibility.',
        details: JSON.stringify(payload, null, 2),
        severity: 'medium',
      },
      requestedByContext: {
        surface: 'terminal',
        actorId: 'agent:video-production',
        actorRole: 'media_producer',
        missionId: mission.id,
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash: hash,
        effectBinding: effect(mission, kind),
      },
    });
  if (kind === 'prototypes') {
    safeWriteFile(
      videoEvidencePath(mission, 'evidence/prototype-approval-requests.json', false),
      JSON.stringify(
        {
          kind: 'video-prototype-acceptance',
          requests: [
            ...preserved,
            ...pending.references.map((ref) => ({
              scene_id: ref.scene_id,
              request_id: record.id,
            })),
          ].sort((a, b) => a.scene_id.localeCompare(b.scene_id)),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    safeWriteFile(
      videoEvidencePath(mission, 'evidence/playback-approval-request.json', false),
      JSON.stringify({ kind: 'video-playback-approval', request_id: record.id }, null, 2) + '\n'
    );
  }
  return {
    request_ids: [record.id],
    not_required: false,
    artifact_path:
      kind === 'prototypes'
        ? 'evidence/prototype-approval-requests.json'
        : 'evidence/playback-approval-request.json',
  };
}
