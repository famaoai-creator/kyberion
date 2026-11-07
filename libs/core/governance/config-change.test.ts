import { describe, expect, it } from 'vitest';
import {
  assertConfigChangeApplyable,
  computeConfigChangeFingerprint,
  configChangeRequiresApproval,
  normalizeConfigChangeEnvelope,
} from './config-change.js';

const scope = {
  scope_kind: 'tenant' as const,
  tier: 'confidential' as const,
  tenant_slug: 'tenant-a',
};

describe('config change contract', () => {
  it('fingerprints configuration without retaining secret values', () => {
    const first = computeConfigChangeFingerprint({
      preset_id: 'new-service-integration',
      target_kind: 'tenant',
      scope,
      inputs: { service_id: 'slack', api_key: 'secret-a' },
      write_targets: ['knowledge/confidential/{{tenant}}/service-auth/slack.json'],
    });
    const second = computeConfigChangeFingerprint({
      preset_id: 'new-service-integration',
      target_kind: 'tenant',
      scope,
      inputs: { service_id: 'slack', api_key: 'secret-b' },
      write_targets: ['knowledge/confidential/{{tenant}}/service-auth/slack.json'],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires approval for reachability-changing target kinds', () => {
    expect(configChangeRequiresApproval({ target_kind: 'surface', risk: 'medium' })).toBe(true);
    expect(configChangeRequiresApproval({ target_kind: 'tenant', risk: 'medium' })).toBe(false);
    expect(configChangeRequiresApproval({ target_kind: 'tenant', risk: 'high' })).toBe(true);
  });

  it('fails closed when an approved payload does not match', () => {
    const envelope = normalizeConfigChangeEnvelope({
      change_id: 'cfg-1',
      scope,
      target_kind: 'tenant',
      requested_by: 'operator',
      risk: 'high',
      desired_hash: 'a'.repeat(64),
      approval_ref: 'apr-1',
      probe_refs: { viewer_scope: 'audit-1' },
    });
    expect(() =>
      assertConfigChangeApplyable({
        envelope,
        approval: {
          status: 'approved',
          payloadHash: 'b'.repeat(64),
          scope,
        },
      })
    ).toThrow('CONFIG_CHANGE_APPROVAL_MISMATCH');
  });

  it('requires preflight evidence before applying an approved high-risk change', () => {
    const envelope = normalizeConfigChangeEnvelope({
      change_id: 'cfg-2',
      scope,
      target_kind: 'tenant',
      requested_by: 'operator',
      risk: 'high',
      desired_hash: 'a'.repeat(64),
      approval_ref: 'apr-2',
      probe_refs: {},
    });
    expect(() =>
      assertConfigChangeApplyable({
        envelope,
        approval: { status: 'approved', payloadHash: envelope.desired_hash, scope },
      })
    ).toThrow('CONFIG_CHANGE_PREFLIGHT_REQUIRED');
  });

  it('rejects an approval from another tenant even when the payload hash matches', () => {
    const envelope = normalizeConfigChangeEnvelope({
      change_id: 'cfg-3',
      scope,
      target_kind: 'tenant',
      requested_by: 'operator',
      risk: 'high',
      desired_hash: 'a'.repeat(64),
      approval_ref: 'apr-3',
      probe_refs: { service_readiness: 'audit-3' },
    });
    expect(() =>
      assertConfigChangeApplyable({
        envelope,
        approval: {
          status: 'approved',
          payloadHash: envelope.desired_hash,
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' },
        },
      })
    ).toThrow('CONFIG_CHANGE_APPROVAL_SCOPE_MISMATCH');
  });

  it('rejects an approval bound to another NHI', () => {
    const envelope = normalizeConfigChangeEnvelope({
      change_id: 'cfg-4',
      scope: { ...scope, nhi_id: 'nhi://tenant-a/agent-a' },
      target_kind: 'tenant',
      requested_by: 'operator',
      risk: 'high',
      desired_hash: 'a'.repeat(64),
      approval_ref: 'apr-4',
      probe_refs: { nhi: 'audit-4' },
    });
    expect(() =>
      assertConfigChangeApplyable({
        envelope,
        approval: {
          status: 'approved',
          payloadHash: envelope.desired_hash,
          scope: { ...scope, nhi_id: 'nhi://tenant-a/agent-b' },
        },
      })
    ).toThrow('CONFIG_CHANGE_APPROVAL_SCOPE_MISMATCH');
  });
});
