import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeRmSync } from './index.js';
import {
  advertiseMeshCapabilities,
  expireMeshPresence,
  listEligibleMeshPeers,
  recordMeshHeartbeat,
  registerMeshPeer,
  resolveMeshPeer,
} from './mesh-peer-directory.js';

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
  });

  afterEach(() => {
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
      }),
    ).toThrow(/registration_authority_denied/i);
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

    const resolved = resolveMeshPeer('peer-a1');
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

    const staleExpired = expireMeshPresence('2026-06-24T00:03:00.000Z');
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
        },
      ),
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
        },
      ),
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

    const resolved = resolveMeshPeer('bootstrap-peer');
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
        },
      ),
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
      }),
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
        },
      ),
    ).toEqual([]);
  });
});
