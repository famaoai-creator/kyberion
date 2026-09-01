import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  createApprovalRequest,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { isValidTenantSlug } from './entity-scope.js';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { resolveMeshPeer } from './mesh-peer-directory.js';
import { recordProtocolServiceLifecycleBestEffort } from './protocol-service-lifecycle.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
} from './secure-io.js';

const RECOVERY_ROLE: GovernedArtifactRole = 'mission_controller';
const RECOVERY_APPROVAL_CHANNEL = 'peer-recovery';

export interface PeerRuntimeRecoveryApprovalInput {
  tenantId: string;
  quarantinePath: string;
  requestedBy: string;
  expiresAt?: string;
  approvalChannel?: string;
}

export interface PeerRuntimeRecoveryResumeInput {
  tenantId: string;
  quarantinePath: string;
  approvalRequestId: string;
  approvalChannel?: string;
  now?: string | Date;
}

export interface PeerRuntimeRecoveryResult {
  tenant_id: string;
  quarantine_path: string;
  approval_request_id: string;
  resumed_at: string;
  restored_labels: string[];
  verified_peers: string[];
}

interface QuarantineManifest {
  format: 'kyberion-peer-runtime-quarantine-v1';
  tenant: string;
  created_at: string;
  reason: string;
  moved: string[];
}

function normalizeTenant(tenantId: string): string {
  const normalized = String(tenantId || '').trim();
  if (!isValidTenantSlug(normalized))
    throw new Error(`peer_recovery_invalid_tenant_id:${normalized}`);
  return normalized;
}

function iso(value?: string | Date): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('peer_recovery_invalid_timestamp');
  return date.toISOString();
}

function effectBinding(tenantId: string, quarantinePath: string): string {
  return `peer-runtime-recovery:${tenantId}:${createHash('sha256')
    .update(quarantinePath)
    .digest('hex')
    .slice(0, 24)}`;
}

function normalizeQuarantinePath(quarantinePath: string, tenantId: string): string {
  const normalized = String(quarantinePath || '')
    .trim()
    .replaceAll('\\', '/');
  const prefix = `active/shared/runtime/peer-recovery-quarantine/tenants/${tenantId}/`;
  if (normalized.split('/').includes('..')) {
    throw new Error('peer_recovery_quarantine_path_outside_tenant_root');
  }
  const resolved = pathResolver.resolve(normalized);
  const expectedRoot = path.resolve(pathResolver.resolve(prefix));
  if (resolved !== expectedRoot && !resolved.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error('peer_recovery_quarantine_path_outside_tenant_root');
  }
  const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  return path
    .relative(pathResolver.rootDir(), safeResolved)
    .split(path.sep)
    .join('/')
    .replace(/\/+$/u, '');
}

function readManifest(quarantinePath: string, tenantId: string): QuarantineManifest {
  const manifestPath = assertSafeRepositoryPath(
    path.join(quarantinePath, 'quarantine-manifest.json')
  );
  if (!safeExistsSync(manifestPath)) throw new Error('peer_recovery_quarantine_manifest_missing');
  let manifest: QuarantineManifest;
  try {
    manifest = readJson<QuarantineManifest>(manifestPath);
  } catch {
    throw new Error('peer_recovery_quarantine_manifest_invalid');
  }
  if (
    manifest.format !== 'kyberion-peer-runtime-quarantine-v1' ||
    manifest.tenant !== tenantId ||
    !Array.isArray(manifest.moved)
  ) {
    throw new Error('peer_recovery_quarantine_manifest_scope_mismatch');
  }
  return manifest;
}

function peerIdsInQuarantine(quarantinePath: string): string[] {
  const peerIds = new Set<string>();
  for (const label of ['runtime-peer-messaging', 'runtime-peer-conversations']) {
    const peersPath = assertSafeRepositoryPath(path.join(quarantinePath, label, 'peers'), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(peersPath)) continue;
    for (const peerId of safeReaddir(peersPath)) {
      if (!/^[^./\\][^/\\]*$/u.test(peerId)) {
        throw new Error(`peer_recovery_invalid_peer_id:${peerId}`);
      }
      assertSafeRepositoryPath(path.join(peersPath, peerId));
      peerIds.add(peerId);
    }
  }
  return [...peerIds].sort();
}

function requireApproval(
  input: PeerRuntimeRecoveryResumeInput,
  tenantId: string,
  normalizedQuarantinePath: string
): ApprovalRequestRecord {
  const channel = input.approvalChannel || RECOVERY_APPROVAL_CHANNEL;
  const approval = loadApprovalRequest(channel, input.approvalRequestId);
  if (!approval) throw new Error(`peer_recovery_approval_not_found:${input.approvalRequestId}`);
  if (approval.status !== 'approved') {
    throw new Error(`peer_recovery_approval_not_approved:${approval.status}`);
  }
  if (
    approval.accountability?.finalDecision !== 'human_only' ||
    !approval.decidedBy ||
    !approval.decidedAuthMethod ||
    approval.decidedAuthMethod === 'local_token'
  ) {
    throw new Error('peer_recovery_approval_requires_authenticated_human');
  }
  if (approval.accountability.effectBinding !== effectBinding(tenantId, normalizedQuarantinePath)) {
    throw new Error('peer_recovery_approval_effect_mismatch');
  }
  return approval;
}

function destinationForLabel(label: string, tenantId: string): string | null {
  const mappings: Record<string, string> = {
    'runtime-peer-messaging': `active/shared/runtime/peer-messaging/tenants/${tenantId}`,
    'observability-peer-messaging': `active/shared/observability/peer-messaging/tenants/${tenantId}`,
    'runtime-peer-conversations': `active/shared/runtime/peer-conversations/tenants/${tenantId}`,
    'observability-peer-conversations': `active/shared/observability/peer-conversations/tenants/${tenantId}`,
    'runtime-mesh-hub': `active/shared/runtime/mesh-hub/tenants/${tenantId}`,
    'observability-mesh-hub': `active/shared/observability/mesh-hub/tenants/${tenantId}`,
  };
  for (const [prefix, base] of Object.entries(mappings)) {
    if (label === prefix) return base;
    if (label.startsWith(`${prefix}-`)) {
      const namespace = label.slice(prefix.length + 1);
      if (!namespace) return null;
      const root = prefix.startsWith('observability-')
        ? 'active/shared/observability/mesh-hub'
        : 'active/shared/runtime/mesh-hub';
      return `${root}/${namespace}/tenants/${tenantId}`;
    }
  }
  return null;
}

export function createPeerRuntimeRecoveryApprovalRequest(
  input: PeerRuntimeRecoveryApprovalInput
): ApprovalRequestRecord {
  const tenantId = normalizeTenant(input.tenantId);
  const quarantinePath = normalizeQuarantinePath(input.quarantinePath, tenantId);
  const requestedBy = String(input.requestedBy || '').trim();
  if (!quarantinePath || !requestedBy) {
    throw new Error('peer_recovery_approval_missing_required_fields');
  }
  readManifest(quarantinePath, tenantId);
  const binding = effectBinding(tenantId, quarantinePath);
  const approvalChannel = input.approvalChannel || RECOVERY_APPROVAL_CHANNEL;
  return createApprovalRequest(RECOVERY_ROLE, {
    channel: approvalChannel,
    storageChannel: approvalChannel,
    threadTs: `peer-recovery:${tenantId}`,
    correlationId: binding,
    requestedBy,
    kind: 'channel-approval',
    expiresAt: input.expiresAt,
    draft: {
      title: `Resume quarantined peer runtime for ${tenantId}`,
      summary: `Re-enable restored peer/Mesh runtime after re-enrollment and fresh heartbeat checks.`,
      details: `Quarantine: ${quarantinePath}`,
      severity: 'high',
    },
    target: {
      serviceId: 'kyberion-peer-runtime',
      secretKey: tenantId,
      mutation: 'refresh',
      store: 'connection_document',
    },
    justification: {
      reason: 'Tenant restore completed; peer runtime requires explicit resume authorization.',
      requestedEffects: ['restore quarantined peer and Mesh runtime records'],
    },
    risk: {
      level: 'high',
      restartScope: 'runtime',
      requiresStrongAuth: true,
      policyId: 'peer-runtime-recovery-v1',
    },
    accountability: {
      finalDecision: 'human_only',
      effectBinding: binding,
    },
  });
}

export function resumePeerRuntimeFromQuarantine(
  input: PeerRuntimeRecoveryResumeInput
): PeerRuntimeRecoveryResult {
  const tenantId = normalizeTenant(input.tenantId);
  const quarantinePath = normalizeQuarantinePath(input.quarantinePath, tenantId);
  if (!quarantinePath) throw new Error('peer_recovery_quarantine_path_required');
  const manifest = readManifest(quarantinePath, tenantId);
  const approval = requireApproval(input, tenantId, quarantinePath);
  const now = iso(input.now);
  const peerIds = peerIdsInQuarantine(quarantinePath);
  for (const peerId of peerIds) {
    const entry = resolveMeshPeer(tenantId, peerId);
    if (
      !entry ||
      entry.status !== 'enrolled' ||
      !entry.presence ||
      entry.presence.expires_at <= now
    ) {
      throw new Error(`peer_recovery_fresh_heartbeat_required:${peerId}`);
    }
  }

  const labels = safeReaddir(quarantinePath).filter(
    (entry) => entry !== 'quarantine-manifest.json' && entry !== 'recovery-events.jsonl'
  );
  const moves = labels.map((label) => {
    const destination = destinationForLabel(label, tenantId);
    if (!destination) throw new Error(`peer_recovery_unknown_quarantine_label:${label}`);
    if (safeExistsSync(destination)) {
      throw new Error(`peer_recovery_destination_exists:${destination}`);
    }
    return {
      label,
      source: assertSafeRepositoryPath(path.join(quarantinePath, label)),
      destination: assertSafeRepositoryPath(pathResolver.resolve(destination), {
        allowMissingLeaf: true,
      }),
    };
  });
  for (const move of moves) {
    safeMkdir(path.dirname(move.destination), { recursive: true });
    safeMoveSync(move.source, move.destination);
  }
  const recoveryEventsPath = assertSafeRepositoryPath(
    path.join(quarantinePath, 'recovery-events.jsonl'),
    { allowMissingLeaf: true }
  );
  appendGovernedArtifactJsonl(RECOVERY_ROLE, pathResolver.toRepoRelative(recoveryEventsPath), {
    ts: now,
    type: 'peer_runtime_recovery_resumed',
    tenant_id: tenantId,
    quarantine_path: quarantinePath,
    approval_request_id: approval.id,
    approved_by: approval.decidedBy,
    restored_labels: moves.map((move) => move.label),
    verified_peers: peerIds,
    source_manifest_created_at: manifest.created_at,
  });
  recordProtocolServiceLifecycleBestEffort({
    serviceId: 'peer-messaging',
    action: 'restore',
    status: 'restored',
    scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
    actorRole: RECOVERY_ROLE,
    requestedBy: approval.decidedBy || 'peer-recovery',
    principal: { kind: 'service', id: 'peer-runtime-recovery' },
    correlationId: approval.id,
    metadata: {
      quarantine_path: quarantinePath,
      restored_labels: moves.length,
      verified_peers: peerIds.length,
    },
  });
  return {
    tenant_id: tenantId,
    quarantine_path: quarantinePath,
    approval_request_id: approval.id,
    resumed_at: now,
    restored_labels: moves.map((move) => move.label),
    verified_peers: peerIds,
  };
}

export { RECOVERY_APPROVAL_CHANNEL };
