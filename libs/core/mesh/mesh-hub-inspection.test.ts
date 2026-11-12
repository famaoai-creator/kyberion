import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver, safeReadFile, safeRmSync, safeWriteFile } from '../index.js';
import { appendGovernedArtifactJsonl } from '../workforce/artifact-store.js';
import {
  advertiseMeshCapabilities,
  recordMeshHeartbeat,
  registerMeshPeer,
} from './mesh-peer-directory.js';
import { formatMeshHubInspectionReport, inspectMeshHub } from './mesh-hub-inspection.js';

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-inspection-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);

// The delivery ledger has no writer since the broker was retired (2026-11-12);
// the rows below are the shapes it left behind in a runtime root.
const LEDGER_NAMESPACE = 'mesh-hub-inspection-tests';
const LEDGER_ROOT = `active/shared/runtime/mesh-hub/${LEDGER_NAMESPACE}`;
const LEDGER_TENANT_ROOT = `${LEDGER_ROOT}/tenants/tenant-acme`;
const DELIVERY_ID = 'MHD-inspect-1';

function deliveryRow(status: string, attemptCount: number): Record<string, unknown> {
  return {
    kind: 'mesh-delivery-record',
    delivery_id: DELIVERY_ID,
    message_id: 'MHM-inspect-1',
    request_id: 'meshreq-inspect',
    tenant_scope: { tenant_id: 'tenant-acme', scope: 'same_tenant' },
    request_kind: 'review.request',
    target: { selector: { kind: 'peer', peer_id: 'peer-a1' } },
    payload: {
      classification: 'confidential',
      reference: {
        artifact_ref: 'artifact://tenant-acme/review-brief',
        integrity_hash: 'sha256:0123456789abcdef',
        storage_class: 'artifact_store',
      },
    },
    attempt_count: attemptCount,
    status,
    route: {
      selector: { kind: 'peer', peer_id: 'peer-a1' },
      decision: 'direct',
      selected_peer_id: 'peer-a1',
      selected_at: '2026-06-24T00:03:00.000Z',
      policy_version: '1.0.0',
    },
    created_at: '2026-06-24T00:03:00.000Z',
    idempotency_key: 'idem-meshreq-inspect',
    expires_at: '2026-06-24T00:04:00.000Z',
  };
}

function deadLetterRow(deadLetterId: string, tenantId: string): Record<string, unknown> {
  const { route: _route, message_id: _messageId, ...base } = deliveryRow('dead_lettered', 1);
  return {
    ...base,
    kind: 'mesh-dead-letter-record',
    dead_letter_id: deadLetterId,
    tenant_scope: { tenant_id: tenantId, scope: 'same_tenant' },
    failure_class: 'retry_exhausted',
    redacted_reason: 'retry_exhausted',
  };
}

function clearLedger(): void {
  safeRmSync(path.join(ROOT, LEDGER_ROOT), { recursive: true, force: true });
}

describe('mesh-hub-inspection', () => {
  beforeEach(() => {
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT = TEST_RUNTIME_ROOT.replace(
      'runtime',
      'observability'
    );
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearLedger();
  });

  afterEach(() => {
    clearLedger();
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
  });

  it('reports healthy peers, expired peers, dead letters, and routes', async () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'notification.publish'],
    });
    registerMeshPeer({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-b1.local',
      key_ref: 'vault://mesh/peer-b1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'notification.publish'],
    });

    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });
    recordMeshHeartbeat({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:02:00.000Z',
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request'],
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'announcement.delivery',
      version: '1',
      roles: ['notifier'],
      request_kinds: ['notification.publish'],
    });
    // One snapshot row per state change: the reader reports the latest per key.
    const deliveries = `${LEDGER_TENANT_ROOT}/deliveries.jsonl`;
    appendGovernedArtifactJsonl('infrastructure_sentinel', deliveries, deliveryRow('queued', 0));
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      deliveries,
      deliveryRow('dead_lettered', 1)
    );
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      `${LEDGER_TENANT_ROOT}/dead-letter.jsonl`,
      deadLetterRow('MHDL-inspect-1', 'tenant-acme')
    );

    const report = await inspectMeshHub({
      tenantId: 'tenant-acme',
      now: '2026-06-24T00:03:00.000Z',
      namespace: LEDGER_NAMESPACE,
    });

    expect(
      report.peers.some((peer) => peer.peer_id === 'peer-a1' && peer.heartbeat_state === 'healthy')
    ).toBe(true);
    expect(
      report.peers.some((peer) => peer.peer_id === 'peer-b1' && peer.heartbeat_state === 'expired')
    ).toBe(true);
    expect(
      report.routes.some(
        (route) =>
          route.delivery_id === DELIVERY_ID &&
          route.state === 'dead_lettered' &&
          route.route_explanation.includes('peer:peer-a1')
      )
    ).toBe(true);
    expect(report.delivery_count).toBe(1);
    expect(report.dead_letters.some((deadLetter) => deadLetter.delivery_id === DELIVERY_ID)).toBe(
      true
    );
    expect(report).not.toHaveProperty('topics');

    const rendered = formatMeshHubInspectionReport(report);
    expect(rendered.join('\n')).toContain('peer-a1');
    expect(rendered.join('\n')).toContain('expired');
    expect(rendered.join('\n')).toContain('Dead letters');
  });

  it('reads only the requested tenant dead-letter file and drops rows scoped to another tenant', async () => {
    const acmeFile = `${LEDGER_TENANT_ROOT}/dead-letter.jsonl`;
    const otherFile = `${LEDGER_ROOT}/tenants/tenant-other/dead-letter.jsonl`;
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      acmeFile,
      deadLetterRow('MHDL-acme', 'tenant-acme')
    );
    // A row misfiled under tenant-acme but scoped to another tenant is filtered out.
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      acmeFile,
      deadLetterRow('MHDL-misfiled', 'tenant-other')
    );
    // A row in another tenant's directory is never opened, whatever its scope says.
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      otherFile,
      deadLetterRow('MHDL-other-dir', 'tenant-acme')
    );

    const report = await inspectMeshHub({ tenantId: 'tenant-acme', namespace: LEDGER_NAMESPACE });

    expect(report.dead_letters.map((row) => row.dead_letter_id)).toEqual(['MHDL-acme']);
    expect(report.dead_letter_count).toBe(1);
  });

  it('skips malformed ledger lines and still reports the remaining rows', async () => {
    const deliveries = `${LEDGER_TENANT_ROOT}/deliveries.jsonl`;
    appendGovernedArtifactJsonl('infrastructure_sentinel', deliveries, deliveryRow('queued', 0));
    const deliveriesAbs = path.join(ROOT, deliveries);
    const valid = String(safeReadFile(deliveriesAbs, { encoding: 'utf8' }));
    safeWriteFile(deliveriesAbs, `${valid}{"delivery_id": "MHD-torn", "status"\n"not-a-record"\n`);

    const report = await inspectMeshHub({ tenantId: 'tenant-acme', namespace: LEDGER_NAMESPACE });

    expect(report.routes.map((route) => route.delivery_id)).toEqual([DELIVERY_ID]);
    expect(report.delivery_count).toBe(1);
  });
});
