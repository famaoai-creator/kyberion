import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
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

  it('routes server binding reads through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/mcp-request-context.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('env.KYBERION_');
    expect(source).toContain('getRegisteredEnvText');
  });
});
