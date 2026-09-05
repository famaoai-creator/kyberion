import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './index.js';
import {
  protocolServiceLifecycleLogicalPath,
  portableProtocolServicePathRef,
  readProtocolServiceLifecycleReceipts,
  recordProtocolServiceLifecycle,
} from './protocol-service-lifecycle.js';

const tenant = 'protocol-lifecycle-test';
const scope = { scope_kind: 'tenant' as const, tier: 'confidential' as const, tenant_slug: tenant };

function cleanReceiptRoot(): void {
  const tenantRoot = pathResolver.resolve(
    `active/shared/observability/protocol-services/peer-messaging/tenants/${tenant}`
  );
  withExecutionContext('infrastructure_sentinel', () => {
    if (safeExistsSync(tenantRoot)) safeRmSync(tenantRoot, { recursive: true, force: true });
  });
}

beforeEach(cleanReceiptRoot);
afterEach(cleanReceiptRoot);

describe('protocol service lifecycle receipts', () => {
  it('records and reads a tenant-scoped receipt under the canonical namespace', () => {
    const receipt = recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'reconnect',
      status: 'reconnected',
      scope,
      requestedBy: 'nhi://tenant-owner',
      correlationId: 'reconnect-1',
    });

    expect(receipt).toMatchObject({
      kind: 'protocol-service-lifecycle-receipt.v1',
      service_id: 'peer-messaging',
      action: 'reconnect',
      status: 'reconnected',
      scope,
    });
    expect(protocolServiceLifecycleLogicalPath('peer-messaging', scope)).toBe(
      'active/shared/observability/protocol-services/peer-messaging/tenants/protocol-lifecycle-test/lifecycle.jsonl'
    );
    expect(readProtocolServiceLifecycleReceipts('peer-messaging', scope)).toHaveLength(1);
  });

  it('keeps system receipts outside tenant namespaces', () => {
    const systemScope = { scope_kind: 'system' as const, tier: 'public' as const };
    expect(protocolServiceLifecycleLogicalPath('mcp-server-cowork', systemScope)).toBe(
      'active/shared/observability/protocol-services/mcp-server-cowork/system/lifecycle.jsonl'
    );
  });

  it('fails closed for an unregistered action or service', () => {
    expect(() =>
      recordProtocolServiceLifecycle({
        serviceId: 'peer-messaging',
        action: 'unsupported' as never,
        status: 'started',
        scope,
      })
    ).toThrow('PROTOCOL_LIFECYCLE_ACTION_NOT_REGISTERED');
    expect(() =>
      recordProtocolServiceLifecycle({
        serviceId: 'unknown-service',
        action: 'start',
        status: 'started',
        scope,
      })
    ).toThrow('PROTOCOL_SERVICE_NOT_REGISTERED');
  });

  it('keeps restore actions registered for peer runtime recovery', () => {
    const receipt = recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'restore',
      status: 'restored',
      scope,
      actorRole: 'mission_controller',
      requestedBy: 'human-owner',
      principal: { kind: 'service', id: 'peer-runtime-recovery' },
    });
    expect(receipt.action).toBe('restore');
    expect(receipt.actor_role).toBe('mission_controller');
  });

  it('rejects malformed receipts and scope contamination while reading', () => {
    const logicalPath = protocolServiceLifecycleLogicalPath('peer-messaging', scope);
    withExecutionContext('infrastructure_sentinel', () => {
      safeWriteFile(
        logicalPath,
        `${JSON.stringify({
          kind: 'protocol-service-lifecycle-receipt.v1',
          receipt_id: 'foreign',
          service_id: 'peer-messaging',
          action: 'start',
          status: 'started',
          occurred_at: new Date().toISOString(),
          actor_role: 'infrastructure_sentinel',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'other-tenant' },
        })}\n`
      );
    });
    expect(() => readProtocolServiceLifecycleReceipts('peer-messaging', scope)).toThrow(
      'PROTOCOL_LIFECYCLE_RECEIPT_INVALID'
    );
  });

  it('fails closed when the receipt stream is replaced by a directory', () => {
    const logicalPath = protocolServiceLifecycleLogicalPath('peer-messaging', scope);
    recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'start',
      status: 'started',
      scope,
    });
    withExecutionContext('infrastructure_sentinel', () => {
      safeRmSync(logicalPath, { force: true });
      safeMkdir(logicalPath);
    });

    expect(() => readProtocolServiceLifecycleReceipts('peer-messaging', scope)).toThrow(
      'receipt stream must be a regular file'
    );
  });

  it('stores portable references for external absolute paths', () => {
    expect(portableProtocolServicePathRef('/tmp/kyberion-archive.tar.gz')).toMatch(
      /^external-path:[a-f0-9]{20}$/u
    );
    expect(portableProtocolServicePathRef('active/shared/tmp/archive.tar.gz')).toBe(
      'active/shared/tmp/archive.tar.gz'
    );

    const receipt = recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'health_check',
      status: 'healthy',
      scope,
      metadata: { manifest_path: '/tmp/manifest.json', port: 4100 },
    });
    expect(receipt.metadata).toMatchObject({
      manifest_path: expect.stringMatching(/^external-path:[a-f0-9]{20}$/u),
      port: 4100,
    });
  });
});
