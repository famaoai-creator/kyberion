import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../index.js';
import { readJsonLines } from '../foundation/json.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import {
  advertiseMeshCapabilities,
  expireMeshPresence,
  listEligibleMeshPeers,
  listMeshPeerCapabilityRecords,
  listMeshPeerDirectoryEntries,
  listMeshPeerPresenceRecords,
  listMeshPeerRegistrationRecords,
  recordMeshHeartbeat,
  registerMeshPeer,
  resolveMeshPeer,
  setMeshPeerDirectoryStoreTuningForTests,
} from './mesh-peer-directory.js';

// Compaction audit records would otherwise land in the live audit log.
const retentionAudit = vi.hoisted(() => vi.fn());
vi.mock('../storage-retention-expiry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage-retention-expiry.js')>()),
  appendRetentionAudit: retentionAudit,
}));

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);
const TEST_CATALOG_PATH = path.join(ROOT, 'tests/mesh-peer-network.bootstrap.json');

describe('mesh-peer-directory', () => {
  let savedRuntimeRoot: string | undefined;
  let savedCatalogPath: string | undefined;

  beforeEach(() => {
    savedRuntimeRoot = process.env.KYBERION_MESH_HUB_RUNTIME_ROOT;
    savedCatalogPath = process.env.KYBERION_PEER_NETWORK_CATALOG;
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_PEER_NETWORK_CATALOG = TEST_CATALOG_PATH;
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    resetAppendOnlyStoreMaintenanceState();
    setMeshPeerDirectoryStoreTuningForTests({});
    retentionAudit.mockClear();
  });

  afterEach(() => {
    setMeshPeerDirectoryStoreTuningForTests({});
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    if (savedRuntimeRoot === undefined) delete process.env.KYBERION_MESH_HUB_RUNTIME_ROOT;
    else process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = savedRuntimeRoot;
    if (savedCatalogPath === undefined) delete process.env.KYBERION_PEER_NETWORK_CATALOG;
    else process.env.KYBERION_PEER_NETWORK_CATALOG = savedCatalogPath;
  });

  it('rejects forged registration authority deterministically', () => {
    expect(() =>
      registerMeshPeer({
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        endpoint_ref: 'mesh://peer-a1.local',
        key_ref: 'vault://mesh/peer-a1/key',
        authority_role: 'external_attacker',
      })
    ).toThrow(/registration_authority_denied/i);
  });

  it('rejects tier and shared partition names at every peer tenant boundary', () => {
    for (const tenant_id of ['public', 'confidential', 'personal', 'shared']) {
      expect(() =>
        registerMeshPeer({
          peer_id: 'peer-a1',
          tenant_id,
          endpoint_ref: 'mesh://peer-a1.local',
          key_ref: 'vault://mesh/peer-a1/key',
          authority_role: 'infrastructure_sentinel',
        })
      ).toThrow(/invalid_tenant_id/i);
    }
  });

  it('registers peers, records heartbeats, advertises allowlisted capabilities, and resolves exact peers', () => {
    const registration = registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'capability.query'],
    });

    const heartbeat = recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2099-06-24T00:01:00.000Z',
      expires_at: '2099-06-24T00:06:00.000Z',
      capacity: {
        accepting_new_work: true,
        available_slots: 3,
        max_inflight: 6,
      },
      receive_modes: ['request', 'topic'],
    });

    const capability = advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request', 'capability.query'],
      advertised_at: '2026-06-24T00:02:00.000Z',
    });

    expect(registration.peer_id).toBe('peer-a1');
    expect(heartbeat.expires_at).toBe('2099-06-24T00:06:00.000Z');
    expect(capability.capability_id).toBe('document.review');

    const resolved = resolveMeshPeer('tenant-acme', 'peer-a1');
    expect(resolved).toMatchObject({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      status: 'enrolled',
      source: 'live',
      allowed_request_kinds: ['review.request', 'capability.query'],
    });
    expect(resolved?.presence).toMatchObject({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      expires_at: '2099-06-24T00:06:00.000Z',
    });
    expect(resolved?.capabilities).toHaveLength(1);
  });

  it('fails closed when a tenant registry contains malformed JSONL', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
    });
    const registrationsPath = path.join(
      TEST_RUNTIME_ROOT_ABS,
      'tenants/tenant-acme/registrations.jsonl'
    );
    safeWriteFile(registrationsPath, '{not-json}\n');

    expect(() => resolveMeshPeer('tenant-acme', 'peer-a1')).toThrow();
  });

  it('rejects a tenant runtime directory that is replaced by a symbolic link', () => {
    const targetDir = pathResolver.sharedTmp(`mesh-hub-read-target-${process.pid}`);
    const tenantDir = path.join(TEST_RUNTIME_ROOT_ABS, 'tenants/tenant-acme');
    safeMkdir(targetDir, { recursive: true });
    safeWriteFile(
      path.join(targetDir, 'registrations.jsonl'),
      JSON.stringify({ peer_id: 'peer-a1', tenant_id: 'tenant-acme', status: 'enrolled' }) + '\n'
    );
    safeRmSync(tenantDir, { recursive: true, force: true });
    safeSymlinkSync(targetDir, tenantDir, 'dir');
    try {
      expect(() => resolveMeshPeer('tenant-acme', 'peer-a1')).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(tenantDir, { recursive: true, force: true });
      safeRmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('rejects a peer record file that is replaced by a symbolic link', () => {
    const tenantDir = path.join(TEST_RUNTIME_ROOT_ABS, 'tenants/tenant-acme');
    const targetPath = path.join(TEST_RUNTIME_ROOT_ABS, 'registrations-target.jsonl');
    const linkedPath = path.join(tenantDir, 'registrations.jsonl');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      targetPath,
      JSON.stringify({ peer_id: 'peer-a1', tenant_id: 'tenant-acme', status: 'enrolled' }) + '\n'
    );
    safeSymlinkSync(targetPath, linkedPath);

    expect(() => resolveMeshPeer('tenant-acme', 'peer-a1')).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('excludes stale heartbeats and tenant mismatches from eligibility', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'capability.query'],
    });
    registerMeshPeer({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-bravo',
      endpoint_ref: 'mesh://peer-b1.local',
      key_ref: 'vault://mesh/peer-b1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'capability.query'],
    });

    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:02:00.000Z',
    });
    recordMeshHeartbeat({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-bravo',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });

    const staleExpired = expireMeshPresence('tenant-acme', '2026-06-24T00:03:00.000Z');
    expect(staleExpired.map((entry) => entry.peer_id)).toEqual(['peer-a1']);

    expect(
      listEligibleMeshPeers(
        {
          kind: 'peer',
          peer_id: 'peer-a1',
        },
        {
          tenant_id: 'tenant-acme',
          now: '2026-06-24T00:03:00.000Z',
        }
      )
    ).toEqual([]);

    expect(
      listEligibleMeshPeers(
        {
          kind: 'peer',
          peer_id: 'peer-b1',
        },
        {
          tenant_id: 'tenant-acme',
          now: '2026-06-24T00:03:00.000Z',
        }
      )
    ).toEqual([]);
  });

  it('does not let the bootstrap catalog revive a revoked live peer', () => {
    registerMeshPeer({
      peer_id: 'bootstrap-peer',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://bootstrap-peer.local',
      key_ref: 'vault://mesh/bootstrap-peer/key',
      authority_role: 'infrastructure_sentinel',
      status: 'revoked',
      revoked_at: '2026-06-24T00:01:00.000Z',
      allowed_request_kinds: ['review.request'],
    });

    const resolved = resolveMeshPeer('tenant-acme', 'bootstrap-peer');
    expect(resolved).toMatchObject({
      peer_id: 'bootstrap-peer',
      tenant_id: 'tenant-acme',
      source: 'live',
      status: 'revoked',
      revoked_at: '2026-06-24T00:01:00.000Z',
    });

    expect(
      listEligibleMeshPeers(
        {
          kind: 'peer',
          peer_id: 'bootstrap-peer',
        },
        {
          tenant_id: 'tenant-acme',
          now: '2026-06-24T00:03:00.000Z',
        }
      )
    ).toEqual([]);
  });

  it('rejects capability advertisements outside the enrolled allowlist', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request'],
    });

    expect(() =>
      advertiseMeshCapabilities({
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        capability_id: 'document.review',
        version: '1',
        roles: ['reviewer'],
        request_kinds: ['review.request', 'capability.query'],
      })
    ).toThrow(/capability_outside_allowlist/i);
  });

  it('returns no implicit selection and keeps topic selectors out of directory eligibility', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'capability.query'],
    });
    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request'],
    });

    expect(
      listEligibleMeshPeers(
        {
          kind: 'topic',
          topic: 'release.review',
        },
        {
          tenant_id: 'tenant-acme',
          now: '2026-06-24T00:03:00.000Z',
        }
      )
    ).toEqual([]);
  });
  describe('store bounds', () => {
    const tenantDir = path.join(TEST_RUNTIME_ROOT_ABS, 'tenants/tenant-acme');
    const presencePath = path.join(tenantDir, 'presence.jsonl');

    function enroll(peerId: string): void {
      registerMeshPeer({
        peer_id: peerId,
        tenant_id: 'tenant-acme',
        endpoint_ref: `mesh://${peerId}.local`,
        key_ref: `vault://mesh/${peerId}/key`,
        authority_role: 'infrastructure_sentinel',
        allowed_request_kinds: ['review.request'],
      });
    }

    function beat(peerId: string, minute: number): void {
      const mm = String(minute).padStart(2, '0');
      recordMeshHeartbeat({
        peer_id: peerId,
        tenant_id: 'tenant-acme',
        heartbeat_at: `2099-06-24T01:${mm}:00.000Z`,
        expires_at: `2099-06-24T02:${mm}:00.000Z`,
        capacity: { available_slots: minute },
      });
    }

    it('compacts presence to the latest heartbeat per peer at write time', () => {
      setMeshPeerDirectoryStoreTuningForTests({ presenceCompactMinBytes: 2048 });
      enroll('peer-a1');
      enroll('peer-b1');
      for (let minute = 0; minute < 40; minute++) {
        beat('peer-a1', minute);
        if (minute % 3 === 0) beat('peer-b1', minute);
      }

      const retained = readJsonLines<{ peer_id: string; heartbeat_at: string }>(presencePath);
      // Bounded: far fewer rows than the 54 heartbeats appended.
      expect(retained.length).toBeLessThan(30);
      expect(retentionAudit).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'RETENTION_COMPACT', compact_key: 'peer_id' })
      );
      // The latest heartbeat per peer survives compaction.
      const latest = new Map(retained.map((row) => [row.peer_id, row.heartbeat_at] as const));
      expect(latest.get('peer-a1')).toBe('2099-06-24T01:39:00.000Z');
      expect(latest.get('peer-b1')).toBe('2099-06-24T01:39:00.000Z');
      const entries = listMeshPeerDirectoryEntries('tenant-acme', '2099-06-24T01:50:00.000Z');
      expect(entries.map((entry) => entry.presence?.capacity.available_slots)).toEqual([39, 39]);
      // Raw history is archived inside the tenant's mesh-hub tree, not dropped.
      const archiveDir = path.join(tenantDir, 'presence-archive');
      expect(safeExistsSync(archiveDir)).toBe(true);
      expect(safeReaddir(archiveDir).length).toBeGreaterThan(0);
      // No staging leftovers beside the live file.
      expect(safeReaddir(tenantDir).filter((name) => name.includes('.compacting-'))).toEqual([]);
    });

    it('does not compact presence below the threshold', () => {
      enroll('peer-a1');
      for (let minute = 0; minute < 5; minute++) beat('peer-a1', minute);
      expect(readJsonLines(presencePath)).toHaveLength(5);
      expect(listMeshPeerPresenceRecords('tenant-acme')).toHaveLength(5);
      expect(retentionAudit).not.toHaveBeenCalled();
    });

    it('streams records across many read chunks with the same results as a whole-file read', () => {
      enroll('peer-a1');
      enroll('peer-b1');
      advertiseMeshCapabilities({
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        capability_id: 'document.review',
        version: '1',
        roles: ['reviewer'],
        request_kinds: ['review.request'],
      });
      for (let minute = 0; minute < 12; minute++) beat(minute % 2 ? 'peer-a1' : 'peer-b1', minute);

      const whole = {
        registrations: readJsonLines(path.join(tenantDir, 'registrations.jsonl')),
        presence: readJsonLines(presencePath),
        capabilities: readJsonLines(path.join(tenantDir, 'capabilities.jsonl')),
      };
      const wholeEntries = listMeshPeerDirectoryEntries('tenant-acme', '2099-06-24T01:30:00.000Z');

      // A chunk far smaller than one record forces every line across chunk boundaries.
      setMeshPeerDirectoryStoreTuningForTests({ chunkBytes: 7 });
      expect(listMeshPeerRegistrationRecords('tenant-acme')).toEqual(whole.registrations);
      expect(listMeshPeerPresenceRecords('tenant-acme')).toEqual(whole.presence);
      expect(listMeshPeerCapabilityRecords('tenant-acme')).toEqual(whole.capabilities);
      expect(listMeshPeerDirectoryEntries('tenant-acme', '2099-06-24T01:30:00.000Z')).toEqual(
        wholeEntries
      );
      expect(resolveMeshPeer('tenant-acme', 'peer-a1')?.presence?.heartbeat_at).toBe(
        '2099-06-24T01:11:00.000Z'
      );
    });
  });
});
