import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver, safeExistsSync, safeRmSync } from './index.js';
import {
  protocolServiceLifecycleLogicalPath,
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
});
