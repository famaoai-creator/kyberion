import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { resolveMcpRequestContext, resolveMcpServerIdentity } from './mcp-request-context.js';

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
      safeReadFile(pathResolver.rootResolve('libs/shared-network/src/mcp-request-context.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('env.KYBERION_');
    expect(source).toContain('getRegisteredEnvText');
  });
});

describe('MCP server identity precedence', () => {
  const NHI = 'kyberion://agent/tenant-a/org-a/mcp-bridge';
  const MCP_NHI = 'kyberion://agent/tenant-a/org-a/mcp-server';

  it('resolves defaults when the environment names nothing', () => {
    expect(resolveMcpServerIdentity({})).toEqual({
      principal: 'mcp-client',
      caller_role: 'unknown',
      service_principal_id: 'mcp-server-cowork',
    });
  });

  it('binds the tenant as KYBERION_MCP_TENANT > KYBERION_TENANT', () => {
    expect(
      resolveMcpServerIdentity({
        KYBERION_MCP_TENANT: 'tenant-a',
        KYBERION_TENANT: 'tenant-b',
        KYBERION_TENANT_ID: 'tenant-c',
      })
    ).toMatchObject({ tenant: 'tenant-a', lifecycle_tenant: 'tenant-a' });
    expect(
      resolveMcpServerIdentity({ KYBERION_TENANT: 'tenant-b', KYBERION_TENANT_ID: 'tenant-c' })
    ).toMatchObject({ tenant: 'tenant-b', lifecycle_tenant: 'tenant-b' });
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_TENANT: '', KYBERION_TENANT: 'tenant-b' })
    ).toMatchObject({ tenant: 'tenant-b', lifecycle_tenant: 'tenant-b' });
  });

  it('uses legacy KYBERION_TENANT_ID for the lifecycle receipt only, never as the request binding', () => {
    const env = { KYBERION_TENANT_ID: 'tenant-c' };
    const identity = resolveMcpServerIdentity(env);
    expect(identity.tenant).toBeUndefined();
    expect(identity.lifecycle_tenant).toBe('tenant-c');
    const context = resolveMcpRequestContext({ env });
    expect(context.scope.tenant_slug).toBeUndefined();
    expect(context.scope.tier).toBe('public');
    expect(() => resolveMcpRequestContext({ env, require_tenant: true })).toThrow(
      'MCP_SCOPE_REQUIRED'
    );
    expect(() => resolveMcpRequestContext({ env, requested_tenant: 'tenant-c' })).toThrow(
      'MCP_SCOPE_REQUIRED'
    );
  });

  it('lets a set-but-blank variable decide instead of falling through', () => {
    expect(
      resolveMcpServerIdentity({
        KYBERION_MCP_TENANT: '  ',
        KYBERION_TENANT: 'tenant-b',
        KYBERION_TENANT_ID: 'tenant-c',
      })
    ).not.toHaveProperty('tenant');
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_TENANT: '  ', KYBERION_TENANT: 'tenant-b' })
    ).not.toHaveProperty('lifecycle_tenant');
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_CALLER_ROLE: 'admin', MISSION_ROLE: 'operator' })
        .caller_role
    ).toBe('unknown');
  });

  it('resolves the principal as KYBERION_MCP_PRINCIPAL > KYBERION_BASE_ROLE > mcp-client', () => {
    expect(
      resolveMcpServerIdentity({
        KYBERION_MCP_PRINCIPAL: 'cowork-user',
        KYBERION_BASE_ROLE: 'sovereign',
      }).principal
    ).toBe('cowork-user');
    expect(resolveMcpServerIdentity({ KYBERION_BASE_ROLE: 'sovereign' }).principal).toBe(
      'sovereign'
    );
    expect(resolveMcpServerIdentity({ KYBERION_BASE_ROLE: 'base_worker' }).principal).toBe(
      'worker'
    );
  });

  it('resolves the caller role as KYBERION_MCP_CALLER_ROLE > MISSION_ROLE within the known set', () => {
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_CALLER_ROLE: 'cowork', MISSION_ROLE: 'operator' })
        .caller_role
    ).toBe('cowork');
    expect(resolveMcpServerIdentity({ MISSION_ROLE: 'operator' }).caller_role).toBe('operator');
    expect(resolveMcpServerIdentity({ MISSION_ROLE: 'mcp_server' }).caller_role).toBe('unknown');
    for (const role of ['operator', 'agent', 'cowork', 'service']) {
      expect(resolveMcpServerIdentity({ KYBERION_MCP_CALLER_ROLE: role }).caller_role).toBe(role);
    }
  });

  it('resolves the NHI as KYBERION_MCP_NHI > claimed KYBERION_NHI_ID', () => {
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_NHI: MCP_NHI, KYBERION_NHI_ID: NHI }).nhi_id
    ).toBe(MCP_NHI);
    expect(resolveMcpServerIdentity({ KYBERION_NHI_ID: NHI }).nhi_id).toBe(NHI);
    expect(resolveMcpServerIdentity({ KYBERION_NHI_ID: 'not-an-nhi' })).not.toHaveProperty(
      'nhi_id'
    );
  });

  it('names the lifecycle service principal as KYBERION_MCP_NHI > KYBERION_MCP_PRINCIPAL > mcp-server-cowork', () => {
    expect(
      resolveMcpServerIdentity({ KYBERION_MCP_NHI: MCP_NHI, KYBERION_MCP_PRINCIPAL: 'p' })
        .service_principal_id
    ).toBe(MCP_NHI);
    expect(resolveMcpServerIdentity({ KYBERION_MCP_PRINCIPAL: 'p' }).service_principal_id).toBe(
      'p'
    );
    // Neither the base role nor a claimed runtime NHI names the service.
    expect(
      resolveMcpServerIdentity({ KYBERION_BASE_ROLE: 'sovereign', KYBERION_NHI_ID: NHI })
        .service_principal_id
    ).toBe('mcp-server-cowork');
  });

  it('gives a request context exactly the resolved server identity', () => {
    const env = {
      KYBERION_MCP_TENANT: 'tenant-a',
      KYBERION_TENANT: 'tenant-b',
      KYBERION_TENANT_ID: 'tenant-c',
      KYBERION_MCP_PRINCIPAL: 'cowork-user',
      KYBERION_BASE_ROLE: 'sovereign',
      KYBERION_MCP_CALLER_ROLE: 'cowork',
      MISSION_ROLE: 'operator',
      KYBERION_MCP_NHI: MCP_NHI,
      KYBERION_NHI_ID: NHI,
    };
    expect(resolveMcpRequestContext({ env })).toEqual({
      principal: 'cowork-user',
      caller_role: 'cowork',
      nhi_id: MCP_NHI,
      scope: {
        scope_kind: 'tenant',
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        nhi_id: MCP_NHI,
      },
    });
  });
});
