import { describe, expect, it } from 'vitest';
import { parseConnectionsResponse } from './connections-response';

const connection = {
  binding_id: 'binding-1',
  service_type: 'slack',
  scope: 'tenant:acme',
  target: 'workspace',
  allowed_actions: ['send_message'],
  secret_refs: ['SLACK_TOKEN'],
  approval_policy: { send_message: 'approval_required' },
  tenant_slug: 'acme',
  auth_mode: 'secret-guard',
  reviewAction: 'hold',
};

describe('connections response boundary', () => {
  it('accepts a typed connection response', () => {
    expect(
      parseConnectionsResponse({ connections: [connection], accessRole: 'localadmin' })
    ).toEqual({
      connections: [connection],
      accessRole: 'localadmin',
    });
  });

  it.each([
    { connections: [connection], accessRole: 'admin' },
    {
      connections: [{ ...connection, allowed_actions: ['send_message', 42] }],
      accessRole: 'readonly',
    },
    {
      connections: [{ ...connection, approval_policy: { send_message: 'unknown' } }],
      accessRole: 'readonly',
    },
    { connections: [{ ...connection, auth_mode: [] }], accessRole: 'readonly' },
    { connections: [{ ...connection, reviewAction: 'execute' }], accessRole: 'readonly' },
    { connections: [{ ...connection, metadata: ['secret'] }], accessRole: 'readonly' },
    JSON.parse(
      '{"connections":[{"binding_id":"b","service_type":"x","scope":"s","target":"t","allowed_actions":[],"secret_refs":[],"approval_policy":{},"metadata":{"__proto__":{}}}],"accessRole":"readonly"}'
    ),
    [],
  ])('rejects malformed connections response: %p', (value) => {
    expect(parseConnectionsResponse(value)).toBeUndefined();
  });
});
