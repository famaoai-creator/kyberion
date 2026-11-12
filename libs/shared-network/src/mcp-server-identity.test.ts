/**
 * Behavioural tests for the MCP server identity owner as the engine uses it:
 * the stdio lifecycle receipt, and the request context the governed wrapper
 * hands to tool handlers. Kept apart from mcp-server-engine.test.ts so the
 * real tool catalog is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  registeredTools,
  mockRecordLifecycle,
  mockRecordFeedback,
  mockInvokeOperation,
  resolveSpy,
} = vi.hoisted(() => ({
  registeredTools: new Map<string, (args: unknown) => Promise<any>>(),
  mockRecordLifecycle: vi.fn(),
  mockRecordFeedback: vi.fn(),
  mockInvokeOperation: vi.fn(),
  resolveSpy: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class ResourceTemplate {}
  const McpServer = vi.fn(function (this: any) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.registerTool = vi.fn(
      (name: string, _config: unknown, handler: (args: unknown) => Promise<any>) => {
        registeredTools.set(name, handler);
      }
    );
    this.registerResource = vi.fn();
  });
  return { McpServer, ResourceTemplate };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(function (this: any) {
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('@agent/core/protocol-service-lifecycle', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/protocol-service-lifecycle')>(
    '@agent/core/protocol-service-lifecycle'
  );
  return { ...actual, recordProtocolServiceLifecycle: mockRecordLifecycle };
});

vi.mock('@agent/core/knowledge/knowledge-feedback-loop', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/core/knowledge/knowledge-feedback-loop')
  >('@agent/core/knowledge/knowledge-feedback-loop');
  return { ...actual, recordHumanKnowledgeFeedback: mockRecordFeedback };
});

vi.mock('@agent/core/surface/surface-operation-registry', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/core/surface/surface-operation-registry')
  >('@agent/core/surface/surface-operation-registry');
  return { ...actual, invokeSurfaceOperation: mockInvokeOperation };
});

vi.mock('./mcp-request-context.js', async () => {
  const actual = await vi.importActual<typeof import('./mcp-request-context.js')>(
    './mcp-request-context.js'
  );
  return {
    ...actual,
    resolveMcpRequestContext: (...args: Parameters<typeof actual.resolveMcpRequestContext>) => {
      resolveSpy(...args);
      return actual.resolveMcpRequestContext(...args);
    },
  };
});

import { resolveMcpRequestContext } from './mcp-request-context.js';
import { createKyberionMcpServer, startMcpServerStdio } from './mcp-server-engine.js';

const IDENTITY_ENV = [
  'KYBERION_MCP_TENANT',
  'KYBERION_TENANT',
  'KYBERION_TENANT_ID',
  'KYBERION_MCP_NHI',
  'KYBERION_MCP_PRINCIPAL',
  'KYBERION_MCP_CALLER_ROLE',
  'KYBERION_NHI_ID',
  'KYBERION_NHI_ACTOR',
  'KYBERION_BASE_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'MISSION_ID',
] as const;

function stubIdentityEnv(env: Partial<Record<(typeof IDENTITY_ENV)[number], string>>): void {
  for (const name of IDENTITY_ENV) vi.stubEnv(name, env[name] ?? '');
}

describe('MCP stdio lifecycle receipt identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.clear();
    mockRecordLifecycle.mockReturnValue({});
  });

  afterEach(() => {
    // startMcpServerStdio registers `() => void shutdown()` on both signals.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (String(listener).includes('shutdown')) process.removeListener(signal, listener);
      }
    }
    vi.unstubAllEnvs();
  });

  const TENANT_A = { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' };
  const TENANT_B = { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' };
  const TENANT_C = { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-c' };
  const SYSTEM = { scope_kind: 'system', tier: 'public' };

  it.each([
    ['KYBERION_MCP_TENANT only', { KYBERION_MCP_TENANT: 'tenant-a' }, TENANT_A],
    ['KYBERION_TENANT only', { KYBERION_TENANT: 'tenant-b' }, TENANT_B],
    ['KYBERION_TENANT_ID only', { KYBERION_TENANT_ID: 'tenant-c' }, TENANT_C],
    [
      'KYBERION_MCP_TENANT and KYBERION_TENANT',
      { KYBERION_MCP_TENANT: 'tenant-a', KYBERION_TENANT: 'tenant-b' },
      TENANT_A,
    ],
    ['no tenant variable', {}, SYSTEM],
  ])('records the start receipt for %s', async (_label, env, scope) => {
    stubIdentityEnv(env);
    await startMcpServerStdio();

    expect(mockRecordLifecycle).toHaveBeenCalledTimes(1);
    const receipt = mockRecordLifecycle.mock.calls[0][0];
    expect(receipt).toMatchObject({
      serviceId: 'mcp-server-cowork',
      action: 'start',
      status: 'started',
      principal: { kind: 'service', id: 'mcp-server-cowork' },
      requestedBy: 'mcp-server-cowork',
    });
    expect(receipt.scope).toEqual(scope);
  });

  it('names the receipt principal from KYBERION_MCP_NHI, then KYBERION_MCP_PRINCIPAL', async () => {
    stubIdentityEnv({ KYBERION_MCP_PRINCIPAL: 'cowork-user', KYBERION_BASE_ROLE: 'sovereign' });
    await startMcpServerStdio();
    expect(mockRecordLifecycle.mock.calls[0][0]).toMatchObject({
      principal: { kind: 'service', id: 'cowork-user' },
      requestedBy: 'cowork-user',
    });

    mockRecordLifecycle.mockClear();
    stubIdentityEnv({
      KYBERION_MCP_NHI: 'kyberion://agent/tenant-a/org-a/mcp-server',
      KYBERION_MCP_PRINCIPAL: 'cowork-user',
    });
    await startMcpServerStdio();
    expect(mockRecordLifecycle.mock.calls[0][0].principal).toEqual({
      kind: 'service',
      id: 'kyberion://agent/tenant-a/org-a/mcp-server',
    });
  });

  it('fails server start when KYBERION_MCP_TENANT is not a valid tenant slug', async () => {
    // Such a server could never serve a request (every request context fails
    // the same scope check); the receipt used to ignore the variable, so the
    // server started anyway.
    stubIdentityEnv({ KYBERION_MCP_TENANT: 'bad/tenant' });
    await expect(startMcpServerStdio()).rejects.toThrow(
      "[SCOPE_CONTEXT_INVALID] tenant_slug 'bad/tenant' is invalid or reserved"
    );
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
    expect(() => resolveMcpRequestContext()).toThrow('SCOPE_CONTEXT_INVALID');
  });
});

describe('governed wrapper hands its request context to the handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.clear();
    stubIdentityEnv({
      KYBERION_MCP_TENANT: 'tenant-a',
      KYBERION_MCP_PRINCIPAL: 'cowork-user',
      KYBERION_MCP_CALLER_ROLE: 'cowork',
    });
    mockRecordFeedback.mockReturnValue('feedback/path.jsonl');
    mockInvokeOperation.mockReturnValue({ ok: true, operation: 'workspace.summary', data: {} });
    createKyberionMcpServer();
  });

  afterEach(() => vi.unstubAllEnvs());

  // The mocked server does not strip undeclared keys the way the SDK does, so
  // `mission_id` reaches the wrapper and marks the context it resolved. A handler
  // that resolved its own context again would not carry it.
  it('kyberion.knowledge.feedback records with the wrapper context', async () => {
    const result = await registeredTools.get('kyberion.knowledge.feedback')!({
      document_path: 'knowledge/public/tech-stack/mcp-integration-guide.md',
      verdict: 'useful',
      mission_id: 'MSN-PASS-THROUGH',
    });

    expect(result.isError).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(mockRecordFeedback).toHaveBeenCalledTimes(1);
    expect(mockRecordFeedback.mock.calls[0][0]).toMatchObject({
      actor: 'cowork-user',
      source: 'mcp',
      scope: {
        scope_kind: 'mission',
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        mission_id: 'MSN-PASS-THROUGH',
      },
    });
  });

  it('kyberion.scope.current reports the wrapper context', async () => {
    const result = await registeredTools.get('kyberion.scope.current')!({
      mission_id: 'MSN-PASS-THROUGH',
    });

    expect(result.isError).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('tenant-a');
    expect(result.content[0].text).toContain('MSN-PASS-THROUGH');
  });

  it('kyberion.workspace.summary builds its viewer from the wrapper context', async () => {
    const result = await registeredTools.get('kyberion.workspace.summary')!({});

    expect(result.isError).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(mockInvokeOperation).toHaveBeenCalledTimes(1);
    expect(mockInvokeOperation.mock.calls[0][2].viewer).toMatchObject({
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      tierAccess: ['confidential', 'public'],
      principalId: 'cowork-user',
    });
  });
});
