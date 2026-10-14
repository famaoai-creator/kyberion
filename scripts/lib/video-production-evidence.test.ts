import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  safeSymlinkSync,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  approvalStoreRoots,
  VITEST_APPROVAL_STORE_ROOT,
  computeApprovalPayloadHash,
  decideApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { revokeApprovalRequest } from '@agent/core/governance/approval-revocation';
import { normalizeEventScope } from '@agent/core/event-scope';
import { resolveMissionWorkflowDesign } from '@agent/core/mission/mission-workflow-catalog';
import {
  applyProcessTemplatePlan,
  evaluatePhaseEntryGate,
} from '@agent/core/mission/mission-process-planning';
import {
  checkVideoProductionEvidence,
  requestVideoProductionApproval,
  videoArtifactDigest,
  videoEvidencePath,
  VIDEO_APPROVAL_CHANNEL,
  type VideoMission,
  type VideoScene,
} from './video-production-evidence.js';

let mission: VideoMission;
const write = (name: string, value: unknown) =>
  safeWriteFile(path.join(mission.dir, 'evidence', name), JSON.stringify(value, null, 2) + '\n');
const read = (name: string) =>
  JSON.parse(String(safeReadFile(path.join(mission.dir, 'evidence', name))));
function artifact(name: string, content: string) {
  safeWriteFile(path.join(mission.dir, 'evidence', name), content);
  return { path: 'evidence/' + name, sha256: videoArtifactDigest(mission, 'evidence/' + name) };
}
function fixtures(mode: VideoScene['generation']['mode'] = 'reference_image') {
  write('production-spec.json', {
    kind: 'video-production-spec',
    duration_sec: 5,
    budget: { unit: 'credit', cap: 50, available: 50, base_cost: 10, max_repair_rounds: 3 },
  });
  const scene: VideoScene = {
    scene_id: 'hero',
    duration_sec: 5,
    message: 'Show the product',
    narration: '',
    visual: 'Product on a desk',
    overlay: 'Product',
    audio: '',
    generation: {
      mode,
      max_attempts: mode === 'none' ? 1 : 4,
      cost_per_attempt: mode === 'none' ? 0 : 10,
      quote_source: 'fixture',
      quoted_at: '2000-01-01T00:00:00Z',
    },
    quality_criteria: ['product identity', 'legible overlay'],
    action_cues: [{ time_sec: 0, action: 'Reveal product' }],
    audio_cues: [],
  };
  write('scene-plan.json', { kind: 'video-scene-plan', scenes: [scene] });
  const source = artifact('source.png', 'fixture source image');
  write('prototype-manifest.json', {
    kind: 'video-prototype-manifest',
    references:
      mode === 'reference_image' ? [{ scene_id: 'hero', revision: 1, artifact: source }] : [],
  });
  return scene;
}
function approve(requestId: string) {
  const record = loadApprovalRequest(VIDEO_APPROVAL_CHANNEL, requestId)!;
  return decideApprovalRequest('mission_controller', {
    channel: VIDEO_APPROVAL_CHANNEL,
    requestId,
    decision: 'approved',
    decidedBy: 'user:video-reviewer',
    decidedByRole: 'sovereign',
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderIdentitySource: 'server_resolved',
    payloadHash: record.accountability!.payloadHash,
    effectBinding: record.accountability!.effectBinding,
  });
}
function acceptPrototypes() {
  const result = requestVideoProductionApproval(mission, 'prototypes');
  result.request_ids.forEach(approve);
  write('prototype-acceptance.json', read('prototype-approval-requests.json'));
  return result;
}
function rendered(mode: VideoScene['generation']['mode'] = 'reference_image') {
  const scene = fixtures(mode);
  acceptPrototypes();
  const selected = artifact('take.mp4', 'fixture selected footage');
  const contract = artifact(
    'generation.json',
    JSON.stringify({
      kind: 'video-generation-adf',
      version: '1.0.0',
      prompt: 'Show the product',
      composition: { duration_sec: 5 },
      engine: { provider: 'comfyui', workflow_template: 'basic_text_clip' },
      output: { format: 'mp4' },
    })
  );
  const source = read('prototype-manifest.json').references[0]?.artifact;
  write('asset-manifest.json', {
    kind: 'video-asset-manifest',
    unit: 'credit',
    base_spent: 10,
    assets: [
      {
        scene_id: 'hero',
        status: 'ready',
        generation_mode: mode,
        selected_take: selected,
        ...(source ? { source_reference: source } : {}),
        ...(mode !== 'none' ? { job_id: 'fixture-job-1', generation_contract: contract } : {}),
        scene_plan_hash: computeApprovalPayloadHash(scene as unknown as Record<string, unknown>),
        attempt_count: mode === 'none' ? 0 : 1,
        repair_count: 0,
        spent: mode === 'none' ? 0 : 10,
      },
    ],
  });
  const final = artifact('final-video.mp4', 'fixture composed render');
  write('video-eval-report.json', {
    kind: 'video-eval-report',
    verdict: 'pass',
    flags: [],
    repair_rounds: 0,
    evaluated_render: final,
    scene_plan_sha256: videoArtifactDigest(mission, 'evidence/scene-plan.json'),
    scene_reviews: [
      {
        scene_id: 'hero',
        selected_take_sha256: selected.sha256,
        criteria_checked: scene.quality_criteria,
      },
    ],
  });
  return { scene, selected, source, final };
}

beforeEach(() => {
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  const id = 'MSN-VIDEO-GATE-' + randomUUID().slice(0, 8).toUpperCase();
  vi.stubEnv('VITEST_POOL_ID', 'video-' + id);
  mission = {
    id,
    dir: pathResolver.missionDir(id, 'public'),
    scope: normalizeEventScope({ tier: 'public', mission_id: id, scope_kind: 'mission' }),
  };
  safeMkdir(path.join(mission.dir, 'evidence'), { recursive: true });
  safeWriteFile(
    path.join(mission.dir, 'mission-state.json'),
    JSON.stringify({
      mission_id: id,
      mission_type: 'video_production',
      tier: 'public',
      status: 'planned',
      execution_mode: 'local',
      priority: 3,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: {},
      git: {
        branch: 'mission/fixture',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [],
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  const roots = approvalStoreRoots();
  expect(roots.coordination.startsWith(VITEST_APPROVAL_STORE_ROOT + '/run-')).toBe(true);
  expect(roots.coordination).toContain('/pool-video-' + mission.id + '/');
  expect(roots.observability).toContain('/pool-video-' + mission.id + '/');
  safeRmSync(pathResolver.rootResolve(path.join(roots.coordination, VIDEO_APPROVAL_CHANNEL)), {
    recursive: true,
    force: true,
  });
  safeRmSync(pathResolver.rootResolve(path.join(roots.observability, VIDEO_APPROVAL_CHANNEL)), {
    recursive: true,
    force: true,
  });
  safeRmSync(mission.dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('video production phase evidence', () => {
  it('blocks the real stored generation entry gate until the current images are accepted', async () => {
    fixtures();
    const design = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'video-production',
    });
    applyProcessTemplatePlan({ missionId: mission.id, missionDir: mission.dir, design });
    expect(
      (await evaluatePhaseEntryGate({ missionId: mission.id, phase: 'asset_generation' }))?.verdict
    ).toBe('fail');
    expect(listApprovalRequests({ storageChannels: [VIDEO_APPROVAL_CHANNEL] })).toEqual([]);
    acceptPrototypes();
    expect(
      (await evaluatePhaseEntryGate({ missionId: mission.id, phase: 'asset_generation' }))?.verdict
    ).toBe('pass');
    const manifest = read('prototype-manifest.json');
    manifest.references[0].artifact = artifact('source.png', 'changed source image');
    manifest.references[0].revision = 2;
    write('prototype-manifest.json', manifest);
    expect(
      (await evaluatePhaseEntryGate({ missionId: mission.id, phase: 'asset_generation' }))?.verdict
    ).toBe('fail');
  }, 30_000);

  it('does not request image or playback approval for a non-generated video', () => {
    rendered('none');
    const request = requestVideoProductionApproval(mission, 'playback');
    expect(request.not_required).toBe(true);
    expect(request.request_ids).toEqual([]);
    write('video-playback-approval.json', read('playback-approval-request.json'));
    expect(checkVideoProductionEvidence(mission, 'final').passed).toBe(true);
    expect(listApprovalRequests({ storageChannels: [VIDEO_APPROVAL_CHANNEL] })).toEqual([]);
  });

  it('requires pending text-only generation to complete full playback acceptance', () => {
    rendered('text_only');
    const result = requestVideoProductionApproval(mission, 'playback');
    write('video-playback-approval.json', read('playback-approval-request.json'));
    expect(() => checkVideoProductionEvidence(mission, 'final')).toThrow(/human video approval/);
    approve(result.request_ids[0]);
    expect(checkVideoProductionEvidence(mission, 'final').passed).toBe(true);
    const report = read('video-eval-report.json');
    report.evaluated_render = artifact('final-video.mp4', 'new composed render');
    write('video-eval-report.json', report);
    expect(() => checkVideoProductionEvidence(mission, 'final')).toThrow(
      /old render or evaluation/
    );
  });

  it('rejects old, expired and revoked image acceptance', () => {
    fixtures();
    const approved = approve(requestVideoProductionApproval(mission, 'prototypes').request_ids[0]);
    write('prototype-acceptance.json', read('prototype-approval-requests.json'));
    revokeApprovalRequest('mission_controller', {
      channel: VIDEO_APPROVAL_CHANNEL,
      requestId: approved.id,
      revokedBy: 'user:video-reviewer',
      reason: 'image direction changed',
    });
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(/revoked/);
    const newRequest = requestVideoProductionApproval(mission, 'prototypes').request_ids[0];
    expect(newRequest).not.toBe(approved.id);
    approve(newRequest);
    write('prototype-acceptance.json', read('prototype-approval-requests.json'));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 73 * 60 * 60 * 1000);
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(/expired/);
  });

  it('binds approvals to the exact mission scope, not authored approved booleans', () => {
    fixtures();
    acceptPrototypes();
    expect(() =>
      checkVideoProductionEvidence({ ...mission, id: mission.id + '-OTHER' }, 'generation')
    ).toThrow(/human video approval/);
    write('prototype-acceptance.json', { kind: 'video-prototype-acceptance', approved: true });
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(/Invalid catalog/);
  });

  it('rejects unknown costs, over-budget retakes and excess attempt caps before generation', () => {
    fixtures('text_only');
    requestVideoProductionApproval(mission, 'prototypes');
    write('prototype-acceptance.json', read('prototype-approval-requests.json'));
    const spec = read('production-spec.json');
    spec.budget.cap = 49;
    write('production-spec.json', spec);
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(
      /retake costs exceed/
    );
    spec.budget.cap = 50;
    write('production-spec.json', spec);
    const plan = read('scene-plan.json');
    plan.scenes[0].generation.cost_per_attempt = null;
    write('scene-plan.json', plan);
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(/Invalid catalog/);
    plan.scenes[0].generation.cost_per_attempt = 10;
    plan.scenes[0].generation.max_attempts = 5;
    write('scene-plan.json', plan);
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(/Invalid catalog/);
  });

  it('stops flagged repair when either budget or the three-round limit is exhausted', () => {
    rendered('text_only');
    const assets = read('asset-manifest.json');
    assets.base_spent = 40;
    write('asset-manifest.json', assets);
    const report = read('video-eval-report.json');
    report.verdict = 'repair';
    report.flags = [{ scene_id: 'hero', reason: 'bad motion' }];
    write('video-eval-report.json', report);
    expect(() => checkVideoProductionEvidence(mission, 'repair')).toThrow(/No budget remains/);
    assets.base_spent = 10;
    assets.assets[0].attempt_count = 4;
    assets.assets[0].repair_count = 3;
    assets.assets[0].spent = 40;
    write('asset-manifest.json', assets);
    report.repair_rounds = 3;
    write('video-eval-report.json', report);
    expect(() => checkVideoProductionEvidence(mission, 'repair')).toThrow(/repair round limit/);
    report.verdict = 'pass';
    report.flags = [];
    write('video-eval-report.json', report);
    expect(checkVideoProductionEvidence(mission, 'repair').passed).toBe(true);
  });

  it('rejects a stale selected take or missing genre review criteria', () => {
    rendered();
    const assets = read('asset-manifest.json');
    assets.assets[0].selected_take = artifact('take.mp4', 'replacement take');
    write('asset-manifest.json', assets);
    expect(() => checkVideoProductionEvidence(mission, 'render')).toThrow(/old selected take/);
    const report = read('video-eval-report.json');
    report.scene_reviews[0].selected_take_sha256 = assets.assets[0].selected_take.sha256;
    report.scene_reviews[0].criteria_checked = ['product identity'];
    write('video-eval-report.json', report);
    expect(() => checkVideoProductionEvidence(mission, 'render')).toThrow(/Genre-specific/);
  });

  it('rejects duplicate coverage, mismatched lineage and changed image bytes', () => {
    rendered();
    const assets = read('asset-manifest.json');
    assets.assets[0].source_reference.sha256 = '0'.repeat(64);
    write('asset-manifest.json', assets);
    expect(() => checkVideoProductionEvidence(mission, 'assets')).toThrow(/different source image/);
    assets.assets.push({ ...assets.assets[0] });
    write('asset-manifest.json', assets);
    expect(() => checkVideoProductionEvidence(mission, 'assets')).toThrow(/Duplicate scene/);
    safeWriteFile(path.join(mission.dir, 'evidence/source.png'), 'changed bytes');
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(
      /digest does not match/
    );
  });

  it('refuses traversal and canonical references outside this mission', () => {
    expect(() => videoEvidencePath(mission, 'evidence/../mission-state.json')).toThrow(
      /mission-relative/
    );
    const outside = pathResolver.sharedTmp('video-outside-' + randomUUID());
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'secret.png'), 'other scope');
    try {
      safeSymlinkSync(outside, path.join(mission.dir, 'evidence/linked'), 'dir');
      expect(() => videoEvidencePath(mission, 'evidence/linked/secret.png')).toThrow(
        /mission scope|RESOURCE_PATH_SYMLINK/
      );
    } finally {
      safeRmSync(outside, { recursive: true, force: true });
    }
  });
  it('request helpers preserve task-owned acceptance files and reuse unaffected image decisions', () => {
    const hero = fixtures();
    const plan = read('scene-plan.json');
    plan.scenes.push({ ...hero, scene_id: 'outro', visual: 'Product on a shelf' });
    write('scene-plan.json', plan);
    const spec = read('production-spec.json');
    spec.duration_sec = 10;
    spec.budget.cap = 90;
    spec.budget.available = 90;
    write('production-spec.json', spec);
    const manifest = read('prototype-manifest.json');
    manifest.references.push({
      scene_id: 'outro',
      revision: 1,
      artifact: artifact('outro.png', 'fixture outro image'),
    });
    write('prototype-manifest.json', manifest);
    const first = requestVideoProductionApproval(mission, 'prototypes');
    expect(() => read('prototype-acceptance.json')).toThrow();
    approve(first.request_ids[0]);
    write('prototype-acceptance.json', read('prototype-approval-requests.json'));
    const original = String(
      safeReadFile(path.join(mission.dir, 'evidence/prototype-acceptance.json'))
    );
    manifest.references[0].revision = 2;
    manifest.references[0].artifact = artifact('source.png', 'new hero image');
    write('prototype-manifest.json', manifest);
    const second = requestVideoProductionApproval(mission, 'prototypes');
    expect(second.request_ids).toHaveLength(1);
    expect(second.request_ids[0]).not.toBe(first.request_ids[0]);
    expect(String(safeReadFile(path.join(mission.dir, 'evidence/prototype-acceptance.json')))).toBe(
      original
    );
    const proposed = read('prototype-approval-requests.json');
    expect(proposed.requests.find((ref) => ref.scene_id === 'outro').request_id).toBe(
      first.request_ids[0]
    );
    approve(second.request_ids[0]);
    write('prototype-acceptance.json', proposed);
    expect(checkVideoProductionEvidence(mission, 'generation').passed).toBe(true);
  });

  it('rejects impossible failed retry history before allowing new generation', () => {
    rendered('text_only');
    const assets = read('asset-manifest.json');
    assets.assets[0].status = 'failed';
    assets.assets[0].reason = 'motion mismatch';
    assets.assets[0].attempt_count = 3;
    assets.assets[0].repair_count = 3;
    write('asset-manifest.json', assets);
    expect(() => checkVideoProductionEvidence(mission, 'generation')).toThrow(
      /inconsistent initial and repair/
    );
  });

  it('does not overwrite final playback acceptance when opening a fresh request', () => {
    rendered('text_only');
    const sentinel = { kind: 'video-playback-approval', request_id: randomUUID() };
    write('video-playback-approval.json', sentinel);
    requestVideoProductionApproval(mission, 'playback');
    expect(read('video-playback-approval.json')).toEqual(sentinel);
  });
});
