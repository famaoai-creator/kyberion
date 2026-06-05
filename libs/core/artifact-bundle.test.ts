import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  addItemToArtifactBundle,
  applyBundleApproval,
  buildBundleFromOutcomeContract,
  checkArtifactBundleFulfillment,
  loadArtifactBundle,
  loadLatestArtifactBundleForMission,
  saveArtifactBundle,
} from './artifact-bundle.js';

const missionId = 'MSN-ARTIFACT-BUNDLE-TEST-001';
const missionPath = pathResolver.sharedTmp(`artifact-bundle/${missionId}`);

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('artifact-bundle', () => {
  it('keeps approval status consistent with bundle status', () => {
    const bundle = buildBundleFromOutcomeContract({
      missionId,
      projectId: 'PRJ-ARTIFACT-BUNDLE-001',
      trackId: 'TRK-ARTIFACT-BUNDLE-001',
      trackName: 'Artifact Bundle Track',
      outcomeContract: {
        outcome_id: 'outcome-1',
        expected_artifacts: [{ kind: 'markdown', storage_class: 'artifact_store' }],
      },
      trackRequiredArtifactKinds: ['markdown'],
    });

    const pendingReview = applyBundleApproval(bundle, { verdict: 'approved', reviewer: 'reviewer-1' });
    expect(pendingReview.status).toBe('approved');
    expect(pendingReview.approval.status).toBe('approved');
  });

  it('saves, loads, and evaluates artifact bundle fulfillment', () => {
    const bundle = buildBundleFromOutcomeContract({
      missionId,
      projectId: 'PRJ-ARTIFACT-BUNDLE-001',
      trackId: 'TRK-ARTIFACT-BUNDLE-001',
      trackName: 'Artifact Bundle Track',
      outcomeContract: {
        outcome_id: 'outcome-1',
        expected_artifacts: [{ kind: 'markdown', storage_class: 'artifact_store' }],
      },
      trackRequiredArtifactKinds: ['markdown'],
    });

    const assembled = addItemToArtifactBundle(bundle, {
      artifact_id: 'ART-1',
      kind: 'markdown',
      storage_class: 'artifact_store',
      path: 'deliverables/context.md',
      fulfills_outcome_id: 'outcome-1',
      fulfills_track_requirement: 'markdown',
    });
    const approved = applyBundleApproval(assembled, { verdict: 'approved', reviewer: 'reviewer-1' });
    const filePath = saveArtifactBundle(approved, missionPath);
    expect(safeExistsSync(filePath)).toBe(true);

    const loaded = loadArtifactBundle(missionId, approved.bundle_id, missionPath);
    expect(loaded?.bundle_id).toBe(approved.bundle_id);
    expect(loadLatestArtifactBundleForMission(missionId, missionPath)?.bundle_id).toBe(approved.bundle_id);
    expect(checkArtifactBundleFulfillment(approved)).toMatchObject({ fulfilled: true });
  });
});
