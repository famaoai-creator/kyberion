import { createHash } from 'node:crypto';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';

export type ConfigChangeTargetKind =
  | 'system'
  | 'tenant'
  | 'organization'
  | 'project'
  | 'mission'
  | 'task'
  | 'surface'
  | 'channel'
  | 'personal';

export type ConfigChangeRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ConfigChangeEnvelope {
  change_id: string;
  scope: EventScope;
  target_kind: ConfigChangeTargetKind;
  requested_by: string;
  nhi_id?: string;
  risk: ConfigChangeRisk;
  before_hash?: string;
  desired_hash: string;
  approval_ref?: string;
  probe_refs: Record<string, string>;
  rollback_ref?: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/i;

function requireText(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`[CONFIG_CHANGE_INVALID] ${label} is required`);
  return normalized;
}

function normalizeHash(value: unknown, label: string, required: boolean): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    if (required) throw new Error(`[CONFIG_CHANGE_INVALID] ${label} is required`);
    return undefined;
  }
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error(`[CONFIG_CHANGE_INVALID] ${label} must be a sha256 hex digest`);
  }
  return normalized;
}

/** Stable, secret-safe fingerprint for the desired configuration effect. */
export function computeConfigChangeFingerprint(input: {
  preset_id: string;
  target_kind: ConfigChangeTargetKind;
  scope: EventScopeInput;
  inputs: Record<string, unknown>;
  write_targets: string[];
}): string {
  const redactSecrets = (key: string, value: unknown): unknown => {
    if (/(secret|token|password|api[_-]?key|credential|private[_-]?key)/iu.test(key)) {
      return '[redacted]';
    }
    if (Array.isArray(value)) return value.map((entry) => redactSecrets(key, entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([entryKey, entry]) => [entryKey, redactSecrets(entryKey, entry)])
      );
    }
    return value;
  };
  const canonical = JSON.stringify({
    preset_id: requireText(input.preset_id, 'preset_id'),
    target_kind: input.target_kind,
    scope: normalizeEventScope(input.scope),
    inputs: redactSecrets('inputs', input.inputs),
    write_targets: [...input.write_targets].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Configuration effects that can change reachability or a data boundary need approval. */
export function configChangeRequiresApproval(input: {
  target_kind: ConfigChangeTargetKind;
  risk: ConfigChangeRisk;
}): boolean {
  return (
    input.risk === 'high' ||
    input.risk === 'critical' ||
    input.target_kind === 'system' ||
    input.target_kind === 'surface' ||
    input.target_kind === 'channel'
  );
}

export function normalizeConfigChangeEnvelope(
  input: Omit<ConfigChangeEnvelope, 'scope'> & { scope: EventScopeInput }
): ConfigChangeEnvelope {
  const scope = normalizeEventScope(input.scope);
  const desiredHash = normalizeHash(input.desired_hash, 'desired_hash', true)!;
  const beforeHash = normalizeHash(input.before_hash, 'before_hash', false);
  const approvalRef = input.approval_ref?.trim() || undefined;
  const probeRefs = Object.fromEntries(
    Object.entries(input.probe_refs || {})
      .map(([key, value]) => [key.trim(), String(value || '').trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
  return {
    change_id: requireText(input.change_id, 'change_id'),
    scope,
    target_kind: input.target_kind,
    requested_by: requireText(input.requested_by, 'requested_by'),
    ...(input.nhi_id?.trim() ? { nhi_id: input.nhi_id.trim() } : {}),
    risk: input.risk,
    ...(beforeHash ? { before_hash: beforeHash } : {}),
    desired_hash: desiredHash,
    ...(approvalRef ? { approval_ref: approvalRef } : {}),
    probe_refs: probeRefs,
    ...(input.rollback_ref?.trim() ? { rollback_ref: input.rollback_ref.trim() } : {}),
  };
}

/** Fail closed before applying a configuration change or a drifted approval. */
export function assertConfigChangeApplyable(input: {
  envelope: ConfigChangeEnvelope;
  approval?: { status?: string; payloadHash?: string };
}): void {
  const envelope = normalizeConfigChangeEnvelope(input.envelope);
  if (configChangeRequiresApproval(envelope)) {
    if (Object.keys(envelope.probe_refs).length === 0) {
      throw new Error(
        '[CONFIG_CHANGE_PREFLIGHT_REQUIRED] at least one probe reference is required'
      );
    }
    if (!envelope.approval_ref) {
      throw new Error('[CONFIG_CHANGE_APPROVAL_REQUIRED] approval_ref is required before apply');
    }
    if (!input.approval) {
      throw new Error('[CONFIG_CHANGE_APPROVAL_REQUIRED] approval record was not found');
    }
    if (!['approved', 'applied'].includes(String(input.approval.status))) {
      throw new Error(
        `[CONFIG_CHANGE_APPROVAL_REQUIRED] approval status '${String(input.approval.status || 'unknown')}' is not approved`
      );
    }
    if (input.approval.payloadHash !== envelope.desired_hash) {
      throw new Error(
        '[CONFIG_CHANGE_APPROVAL_MISMATCH] approval payload does not match desired config'
      );
    }
  }
}
