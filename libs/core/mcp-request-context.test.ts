import { describe, expect, it } from 'vitest';
import { resolveMcpRequestContext } from './mcp-request-context.js';

describe('MCP request context', () => {
  it('uses a server binding and treats a client tenant as narrowing only', () => {
    const context = resolveMcpRequestContext({
      requested_tenant: 'tenant-a',
      require_tenant: true,
      env: {
        KYBERION_MCP_TENANT: 'tenant-a',
        KYBERION_MCP_PRINCIPAL: 'cowork-user',
        KYBERION_MCP_CALLER_ROLE: 'cowork',
      },
    });
    expect(context.scope.tenant_slug).toBe('tenant-a');
    expect(context.scope.tier).toBe('confidential');
    expect(context.principal).toBe('cowork-user');
  });

  it('rejects a client tenant without a server-side grant', () => {
    expect(() => resolveMcpRequestContext({ requested_tenant: 'tenant-a', env: {} })).toThrow(
      'MCP_SCOPE_REQUIRED'
    );
  });

  it('rejects cross-tenant narrowing', () => {
    expect(() =>
      resolveMcpRequestContext({
        requested_tenant: 'tenant-b',
        env: { KYBERION_MCP_TENANT: 'tenant-a' },
      })
    ).toThrow('MCP_SCOPE_MISMATCH');
  });
});
