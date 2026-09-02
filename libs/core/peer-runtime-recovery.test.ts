import { afterEach, describe, expect, it } from 'vitest';

import {
  decideApprovalRequest,
  registerMeshPeer,
  recordMeshHeartbeat,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';
import {
  createPeerRuntimeRecoveryApprovalRequest,
  resumePeerRuntimeFromQuarantine,
} from './peer-runtime-recovery.js';

const TENANT_ID = 'tenant-recovery-test';
const PEER_ID = 'peer-recovery-test';
const QUARANTINE_PATH = `active/shared/runtime/peer-recovery-quarantine/tenants/${TENANT_ID}/recovery-test`;
const APPROVAL_CHANNEL = 'peer-recovery-test';

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(`active/shared/runtime/peer-recovery-quarantine/tenants/${TENANT_ID}`, {
      recursive: true,
      force: true,
    });
    safeRmSync(`active/shared/runtime/peer-messaging/tenants/${TENANT_ID}`, {
      recursive: true,
      force: true,
    });
    safeRmSync(`active/shared/runtime/mesh-hub/tenants/${TENANT_ID}`, {
      recursive: true,
      force: true,
    });
    safeRmSync(`active/shared/coordination/channels/${APPROVAL_CHANNEL}`, {
      recursive: true,
      force: true,
    });
  });
});

describe('peer runtime recovery gate', () => {
  it('requires approval and a fresh heartbeat before resuming quarantined state', () => {
    safeMkdir(`${QUARANTINE_PATH}/runtime-peer-messaging/peers/${PEER_ID}`);
    safeWriteFile(
      `${QUARANTINE_PATH}/runtime-peer-messaging/peers/${PEER_ID}/state.json`,
      '{"restored":true}\n'
    );
    safeWriteFile(
      `${QUARANTINE_PATH}/quarantine-manifest.json`,
      JSON.stringify({
        format: 'kyberion-peer-runtime-quarantine-v1',
        tenant: TENANT_ID,
        created_at: new Date().toISOString(),
        reason: 'test',
        moved: [`${QUARANTINE_PATH}/runtime-peer-messaging`],
      })
    );

    const approval = createPeerRuntimeRecoveryApprovalRequest({
      tenantId: TENANT_ID,
      quarantinePath: QUARANTINE_PATH,
      requestedBy: 'test-operator',
      approvalChannel: APPROVAL_CHANNEL,
    });
    expect(() =>
      resumePeerRuntimeFromQuarantine({
        tenantId: TENANT_ID,
        quarantinePath: QUARANTINE_PATH,
        approvalRequestId: approval.id,
        approvalChannel: APPROVAL_CHANNEL,
      })
    ).toThrow(/approval_not_approved/);

    decideApprovalRequest('mission_controller', {
      channel: APPROVAL_CHANNEL,
      storageChannel: APPROVAL_CHANNEL,
      requestId: approval.id,
      decision: 'approved',
      decidedBy: 'test-human',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      effectBinding: approval.accountability?.effectBinding,
    });

    registerMeshPeer({
      peer_id: PEER_ID,
      tenant_id: TENANT_ID,
      endpoint_ref: 'mesh://peer-recovery-test.local',
      key_ref: 'vault://mesh/peer-recovery-test/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request'],
    });
    recordMeshHeartbeat({
      peer_id: PEER_ID,
      tenant_id: TENANT_ID,
      heartbeat_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = resumePeerRuntimeFromQuarantine({
      tenantId: TENANT_ID,
      quarantinePath: `${QUARANTINE_PATH}/`,
      approvalRequestId: approval.id,
      approvalChannel: APPROVAL_CHANNEL,
    });
    expect(result.verified_peers).toEqual([PEER_ID]);
    expect(
      safeExistsSync(
        `active/shared/runtime/peer-messaging/tenants/${TENANT_ID}/peers/${PEER_ID}/state.json`
      )
    ).toBe(true);
    expect(safeExistsSync(`${QUARANTINE_PATH}/runtime-peer-messaging`)).toBe(false);
  });

  it('rejects a symlinked quarantine path before reading its manifest', () => {
    const target = `${QUARANTINE_PATH}/redirect-target`;
    const linked = `${QUARANTINE_PATH}/redirect-link`;
    safeMkdir(target, { recursive: true });
    safeSymlinkSync(target, linked);

    expect(() =>
      createPeerRuntimeRecoveryApprovalRequest({
        tenantId: TENANT_ID,
        quarantinePath: linked,
        requestedBy: 'test-operator',
        approvalChannel: APPROVAL_CHANNEL,
      })
    ).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('rejects a malformed manifest entry before creating an approval request', () => {
    safeMkdir(QUARANTINE_PATH, { recursive: true });
    safeWriteFile(
      `${QUARANTINE_PATH}/quarantine-manifest.json`,
      JSON.stringify({
        format: 'kyberion-peer-runtime-quarantine-v1',
        tenant: TENANT_ID,
        created_at: new Date().toISOString(),
        reason: 'test',
        moved: [{ path: `${QUARANTINE_PATH}/runtime-peer-messaging` }],
      })
    );

    expect(() =>
      createPeerRuntimeRecoveryApprovalRequest({
        tenantId: TENANT_ID,
        quarantinePath: QUARANTINE_PATH,
        requestedBy: 'test-operator',
        approvalChannel: APPROVAL_CHANNEL,
      })
    ).toThrow('peer_recovery_quarantine_manifest_invalid');
  });

  it('rejects a manifest that does not match the quarantined labels', () => {
    safeMkdir(`${QUARANTINE_PATH}/runtime-peer-messaging`, { recursive: true });
    safeWriteFile(
      `${QUARANTINE_PATH}/quarantine-manifest.json`,
      JSON.stringify({
        format: 'kyberion-peer-runtime-quarantine-v1',
        tenant: TENANT_ID,
        created_at: new Date().toISOString(),
        reason: 'test',
        moved: [`${QUARANTINE_PATH}/runtime-peer-conversations`],
      })
    );

    expect(() =>
      createPeerRuntimeRecoveryApprovalRequest({
        tenantId: TENANT_ID,
        quarantinePath: QUARANTINE_PATH,
        requestedBy: 'test-operator',
        approvalChannel: APPROVAL_CHANNEL,
      })
    ).toThrow('peer_recovery_quarantine_manifest_contents_mismatch');
  });

  it('rejects a symlinked recovery event log before appending the receipt', () => {
    safeMkdir(QUARANTINE_PATH, { recursive: true });
    safeWriteFile(
      `${QUARANTINE_PATH}/quarantine-manifest.json`,
      JSON.stringify({
        format: 'kyberion-peer-runtime-quarantine-v1',
        tenant: TENANT_ID,
        created_at: new Date().toISOString(),
        reason: 'test',
        moved: [],
      })
    );
    const approval = createPeerRuntimeRecoveryApprovalRequest({
      tenantId: TENANT_ID,
      quarantinePath: QUARANTINE_PATH,
      requestedBy: 'test-operator',
      approvalChannel: APPROVAL_CHANNEL,
    });
    decideApprovalRequest('mission_controller', {
      channel: APPROVAL_CHANNEL,
      storageChannel: APPROVAL_CHANNEL,
      requestId: approval.id,
      decision: 'approved',
      decidedBy: 'test-human',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      effectBinding: approval.accountability?.effectBinding,
    });
    const target = 'active/shared/tmp/peer-recovery-events-target.jsonl';
    safeWriteFile(target, 'existing\n');
    safeSymlinkSync(target, `${QUARANTINE_PATH}/recovery-events.jsonl`);

    try {
      expect(() =>
        resumePeerRuntimeFromQuarantine({
          tenantId: TENANT_ID,
          quarantinePath: QUARANTINE_PATH,
          approvalRequestId: approval.id,
          approvalChannel: APPROVAL_CHANNEL,
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(target, { force: true });
    }
  });
});
