import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalRequestLogicalPath,
  decideApprovalRequest,
  listApprovalRequests,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';
import {
  CLEANUP_APPROVAL_CHANNEL,
  CLEANUP_EFFECT_BINDING,
  openCleanupApproval,
  runCleanup,
} from './entity_governance_cleanup.js';

const RUN_ID = `${process.pid}-${Date.now()}`;
const FIXTURE_ROOT = pathResolver.sharedTmp(`entity-governance-cleanup-test/${RUN_ID}`);
const MISSION_ID = `MSN-EG-ACCEPTANCE-${RUN_ID}`.toUpperCase();
const CORRELATION_ID = `entity-governance-cleanup-${MISSION_ID}`;

afterEach(() => {
  safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  withExecutionContext('mission_controller', () => {
    for (const record of listApprovalRequests({
      storageChannels: [CLEANUP_APPROVAL_CHANNEL],
    })) {
      if (record.correlationId === CORRELATION_ID) {
        safeRmSync(approvalRequestLogicalPath(CLEANUP_APPROVAL_CHANNEL, record.id), {
          force: true,
        });
      }
    }
  });
});

function seedFixture(): void {
  safeMkdir(path.join(FIXTURE_ROOT, 'active/missions/legacy'), { recursive: true });
  safeWriteFile(
    path.join(FIXTURE_ROOT, 'active/missions/legacy/marker.json'),
    JSON.stringify({ fixture: true })
  );
  safeMkdir(path.join(FIXTURE_ROOT, 'active/projects/public/common/PRJ-UNREGISTERED'), {
    recursive: true,
  });
  safeWriteFile(
    path.join(FIXTURE_ROOT, 'active/projects/public/common/PRJ-UNREGISTERED/README.md'),
    'fixture'
  );
  safeMkdir(path.join(FIXTURE_ROOT, 'knowledge/evolution'), { recursive: true });
  safeWriteFile(path.join(FIXTURE_ROOT, 'knowledge/evolution/distill_fixture.md'), 'fixture');
}

describe('EG-11 entity governance cleanup', () => {
  it('keeps dry-run safe and rejects apply without an approval request', () => {
    seedFixture();

    const dryRun = withExecutionContext(
      'mission_controller',
      () => runCleanup({ missionId: MISSION_ID, rootDir: FIXTURE_ROOT }),
      'worker'
    );

    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun.findings).toHaveLength(3);
    expect(safeExistsSync(path.join(FIXTURE_ROOT, 'active/missions/legacy'))).toBe(true);
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () => runCleanup({ missionId: MISSION_ID, apply: true, rootDir: FIXTURE_ROOT }),
        'worker'
      )
    ).toThrow(/--approval-request-id/);
    expect(safeExistsSync(path.join(FIXTURE_ROOT, 'active/missions/legacy'))).toBe(true);
  });

  it('binds apply to the exact findings set and an authenticated human decision', () => {
    seedFixture();
    const opened = withExecutionContext(
      'surface_runtime',
      () => openCleanupApproval({ missionId: MISSION_ID, rootDir: FIXTURE_ROOT }),
      'worker'
    );
    expect(opened.created).toBe(true);
    expect(opened.requestId).toBeDefined();
    expect(opened.payloadHash).toBeDefined();

    safeMkdir(path.join(FIXTURE_ROOT, 'active/missions/another-invalid-root'), {
      recursive: true,
    });
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () =>
          runCleanup({
            missionId: MISSION_ID,
            apply: true,
            approvalRequestId: opened.requestId,
            rootDir: FIXTURE_ROOT,
          }),
        'worker'
      )
    ).toThrow(/approved mission_gate/);

    const approved = withExecutionContext(
      'mission_controller',
      () =>
        decideApprovalRequest('mission_controller', {
          channel: CLEANUP_APPROVAL_CHANNEL,
          storageChannel: CLEANUP_APPROVAL_CHANNEL,
          requestId: opened.requestId!,
          decision: 'approved',
          decidedBy: 'sovereign-acceptance',
          authMethod: 'passkey',
          decidedByType: 'human',
          authenticated: true,
          payloadHash: opened.payloadHash,
          effectBinding: CLEANUP_EFFECT_BINDING,
        }),
      'worker'
    );
    expect(approved.status).toBe('approved');

    // The approval is for the original findings, so the changed fixture must
    // still fail closed even after a human decision.
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () =>
          runCleanup({
            missionId: MISSION_ID,
            apply: true,
            approvalRequestId: opened.requestId,
            rootDir: FIXTURE_ROOT,
          }),
        'worker'
      )
    ).toThrow(/different findings set/);

    safeRmSync(path.join(FIXTURE_ROOT, 'active/missions/another-invalid-root'), {
      recursive: true,
      force: true,
    });
    const receipt = withExecutionContext(
      'mission_controller',
      () =>
        runCleanup({
          missionId: MISSION_ID,
          apply: true,
          approvalRequestId: opened.requestId,
          rootDir: FIXTURE_ROOT,
        }),
      'worker'
    );

    expect(receipt.mode).toBe('apply');
    expect(receipt.approved_by).toBe('sovereign-acceptance');
    expect(receipt.approval_request_id).toBe(opened.requestId);
    expect(receipt.moved).toHaveLength(3);
    expect(safeExistsSync(path.join(FIXTURE_ROOT, 'active/missions/legacy'))).toBe(false);
    expect(safeExistsSync(path.join(FIXTURE_ROOT, 'knowledge/evolution/distill_fixture.md'))).toBe(
      false
    );
  });
});
