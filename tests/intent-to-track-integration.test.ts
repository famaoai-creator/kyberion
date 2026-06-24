import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectTrackRecord,
  pathResolver,
  resolveIntentTrackGate,
  safeExistsSync,
  safeRmSync,
} from '@agent/core';

const TRACK_PATH = pathResolver.shared('runtime/project-tracks/TRK-TEST-INTENT-INTEGRATION-DELIVERY.json');
const GOVERNANCE_TRACK_PATH = pathResolver.shared('runtime/project-tracks/TRK-TEST-INTENT-INTEGRATION-ENGINEERING-GOVERNANCE.json');
const OPERATIONAL_TRACK_PATH = pathResolver.shared('runtime/project-tracks/TRK-TEST-INTENT-INTEGRATION-OPERATIONAL-GOVERNANCE.json');

function cleanup() {
  if (safeExistsSync(TRACK_PATH)) safeRmSync(TRACK_PATH, { force: true });
  if (safeExistsSync(GOVERNANCE_TRACK_PATH)) safeRmSync(GOVERNANCE_TRACK_PATH, { force: true });
  if (safeExistsSync(OPERATIONAL_TRACK_PATH)) safeRmSync(OPERATIONAL_TRACK_PATH, { force: true });
}

describe('intent-to-track integration', () => {
  beforeEach(() => {
    cleanup();
  });

  it('provisions and persists a project track for a high-confidence mission intent', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'request-feature-development',
      confidence: 0.9,
      projectId: 'PRJ-TEST-INTENT-INTEGRATION',
      missionId: 'MSN-TEST-INTENT-INTEGRATION',
      persist: true,
    });

    expect(result.status).toBe('ready_to_provision');
    if (result.status !== 'ready_to_provision') return;

    const persisted = loadProjectTrackRecord(result.track_record.track_id);
    expect(persisted?.track_id).toBe('TRK-TEST-INTENT-INTEGRATION-DELIVERY');
    expect(persisted?.track_type).toBe('delivery');
    expect(persisted?.lifecycle_model).toBe('sdlc');
    expect(persisted?.metadata?.logical_lifecycle_model).toBe('default-sdlc');
    expect(persisted?.metadata?.gates_per_phase).toMatchObject({
      define: ['gate-requirements-baseline'],
    });
  });

  it('provisions and persists a project track for define-engineering-governance', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'define-engineering-governance',
      confidence: 0.85,
      projectId: 'PRJ-TEST-INTENT-INTEGRATION',
      missionId: 'MSN-TEST-INTENT-INTEGRATION',
      persist: true,
    });

    expect(result.status).toBe('ready_to_provision');
    if (result.status !== 'ready_to_provision') return;

    const persisted = loadProjectTrackRecord(result.track_record.track_id);
    expect(persisted?.track_id).toBe('TRK-TEST-INTENT-INTEGRATION-ENGINEERING-GOVERNANCE');
    expect(persisted?.track_type).toBe('compliance');
    expect(persisted?.lifecycle_model).toBe('sdlc');
    expect(persisted?.metadata?.logical_track_type).toBe('engineering_governance');
    expect(persisted?.metadata?.logical_lifecycle_model).toBe('governance-sdlc');
    expect(persisted?.metadata?.gates_per_phase).toMatchObject({
      findings_analysis: ['COMPLIANCE_FINDINGS_GATE'],
      governance_approval: ['GOVERNANCE_SIGN_OFF_GATE'],
      process_adaptation: ['PROCESS_ADR_MERGE_GATE'],
    });
  });

  it('provisions and persists a project track for define-operational-process', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'define-operational-process',
      confidence: 0.9,
      projectId: 'PRJ-TEST-INTENT-INTEGRATION',
      missionId: 'MSN-TEST-INTENT-INTEGRATION',
      persist: true,
    });

    expect(result.status).toBe('ready_to_provision');
    if (result.status !== 'ready_to_provision') return;

    const persisted = loadProjectTrackRecord(result.track_record.track_id);
    expect(persisted?.track_id).toBe('TRK-TEST-INTENT-INTEGRATION-OPERATIONAL-GOVERNANCE');
    expect(persisted?.track_type).toBe('compliance');
    expect(persisted?.lifecycle_model).toBe('sdlc');
    expect(persisted?.metadata?.logical_track_type).toBe('operational_governance');
    expect(persisted?.metadata?.logical_lifecycle_model).toBe('governance-sdlc');
  });

  it('does not persist a track when confidence is below the gate threshold', async () => {
    const result = await resolveIntentTrackGate({
      intentId: 'request-feature-development',
      confidence: 0.4,
      projectId: 'PRJ-TEST-INTENT-INTEGRATION',
      missionId: 'MSN-TEST-INTENT-INTEGRATION',
      persist: true,
    });

    expect(result.status).toBe('escalation_required');
    expect(safeExistsSync(TRACK_PATH)).toBe(false);
  });
});
