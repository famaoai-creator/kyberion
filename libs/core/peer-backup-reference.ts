import { createPeerMessageNotification, type PeerMessageEnvelope } from './peer-messaging.js';
import { isValidTenantSlug } from './entity-scope.js';

export interface PeerBackupArtifactReference {
  kind: 'backup-artifact-reference';
  tenant_id: string;
  backup_scope: 'tenant';
  artifact_ref: string;
  integrity_hash: string;
  storage_class: 'artifact_store' | 'external_reference' | 'vault';
  created_at: string;
  expires_at: string;
  requires_explicit_acceptance: true;
  restore_mode: 'local_only';
}

export interface BuildPeerBackupArtifactReferenceInput {
  tenantId: string;
  senderPeerId: string;
  recipientPeerId: string;
  sharedSecret: string;
  artifactRef: string;
  integrityHash: string;
  storageClass?: PeerBackupArtifactReference['storage_class'];
  createdAt?: string | Date;
  expiresAt: string | Date;
  conversationId?: string;
  correlationId?: string;
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('backup_reference_invalid_timestamp');
  return date.toISOString();
}

function validateReference(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || /[\r\n]/u.test(normalized)) {
    throw new Error(`backup_reference_invalid_${field}`);
  }
  if (
    field === 'artifact_ref' &&
    /^(?:data:|file:|https?:\/\/[^/]*\/raw|raw:)/iu.test(normalized)
  ) {
    throw new Error('backup_reference_raw_payload_denied');
  }
  return normalized;
}

export function buildPeerBackupArtifactReferenceNotification(
  input: BuildPeerBackupArtifactReferenceInput
): PeerMessageEnvelope<PeerBackupArtifactReference> {
  const tenantId = String(input.tenantId || '').trim();
  if (!isValidTenantSlug(tenantId))
    throw new Error(`backup_reference_invalid_tenant_id:${tenantId}`);
  const artifactRef = validateReference(input.artifactRef, 'artifact_ref');
  const integrityHash = validateReference(input.integrityHash, 'integrity_hash');
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(integrityHash)) {
    throw new Error('backup_reference_invalid_integrity_hash');
  }
  const createdAt = iso(input.createdAt || new Date());
  const expiresAt = iso(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error('backup_reference_expiry_must_be_after_created_at');
  }
  const storageClass = input.storageClass || 'artifact_store';
  if (!['artifact_store', 'external_reference', 'vault'].includes(storageClass)) {
    throw new Error('backup_reference_invalid_storage_class');
  }
  const payload: PeerBackupArtifactReference = {
    kind: 'backup-artifact-reference',
    tenant_id: tenantId,
    backup_scope: 'tenant',
    artifact_ref: artifactRef,
    integrity_hash: integrityHash,
    storage_class: storageClass as PeerBackupArtifactReference['storage_class'],
    created_at: createdAt,
    expires_at: expiresAt,
    requires_explicit_acceptance: true,
    restore_mode: 'local_only',
  };
  return createPeerMessageNotification({
    tenantId,
    senderPeerId: input.senderPeerId,
    recipientPeerId: input.recipientPeerId,
    subject: 'backup.artifact_reference',
    payload,
    sharedSecret: input.sharedSecret,
    conversationId: input.conversationId,
    correlationId: input.correlationId,
  });
}
