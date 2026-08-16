import { describe, expect, it } from 'vitest';

import { buildPeerBackupArtifactReferenceNotification } from './peer-backup-reference.js';

const HASH = 'sha256:' + 'a'.repeat(64);

describe('peer backup artifact reference notification', () => {
  it('sends only a tenant-bound, explicit-acceptance reference', () => {
    const envelope = buildPeerBackupArtifactReferenceNotification({
      tenantId: 'tenant-acme',
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-b',
      sharedSecret: 'secret',
      artifactRef: 'artifact://tenant-acme/backup-2026-08-16',
      integrityHash: HASH,
      createdAt: '2026-08-16T00:00:00.000Z',
      expiresAt: '2026-08-17T00:00:00.000Z',
    });

    expect(envelope).toMatchObject({
      tenant_id: 'tenant-acme',
      type: 'notification',
      subject: 'backup.artifact_reference',
      payload: {
        kind: 'backup-artifact-reference',
        backup_scope: 'tenant',
        requires_explicit_acceptance: true,
        restore_mode: 'local_only',
        integrity_hash: HASH,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('tar.gz');
  });

  it('rejects raw payload references and weak hashes', () => {
    expect(() =>
      buildPeerBackupArtifactReferenceNotification({
        tenantId: 'tenant-acme',
        senderPeerId: 'peer-a',
        recipientPeerId: 'peer-b',
        sharedSecret: 'secret',
        artifactRef: 'data:application/gzip;base64,RAW',
        integrityHash: HASH,
        expiresAt: '2026-08-17T00:00:00.000Z',
      })
    ).toThrow(/raw_payload_denied/);
    expect(() =>
      buildPeerBackupArtifactReferenceNotification({
        tenantId: 'tenant-acme',
        senderPeerId: 'peer-a',
        recipientPeerId: 'peer-b',
        sharedSecret: 'secret',
        artifactRef: 'artifact://tenant-acme/backup',
        integrityHash: 'sha256:weak',
        expiresAt: '2026-08-17T00:00:00.000Z',
      })
    ).toThrow(/invalid_integrity_hash/);
  });
});
