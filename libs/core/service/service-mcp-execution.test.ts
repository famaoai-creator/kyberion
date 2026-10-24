import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  listTools: vi.fn(),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'sent' }] })),
  close: vi.fn(async () => undefined),
  stdioOptions: vi.fn(),
  httpOptions: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = sdk.connect;
    listTools = sdk.listTools;
    callTool = sdk.callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      sdk.httpOptions({ url: String(url), options });
    }
    close = sdk.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      sdk.stdioOptions(options);
    }
    close = sdk.close;
  },
}));
vi.mock('../governance/approval-gate.js', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('../governance/external-operation-store.js', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('../governance/accountability-charter-registry.js', () => ({
  findActiveCharter: vi.fn(() => null),
}));
vi.mock('../scope-envelope.js', async (original) => ({
  ...(await original<typeof import('../scope-envelope.js')>()),
  currentScopeEnvelope: () => undefined,
}));
import { enforceApprovalGate } from '../governance/approval-gate.js';
import { externalApprovalFixture } from '../../../tests/helpers/external-approval-fixture.js';
vi.mock('../governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store.js')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
import {
  withExternalOperationAuthority,
  withOperationArgumentOrigins,
} from '../governance/external-operation.js';
import { withExecutionContextAsync } from '../authority.js';
import { registerMemoryProvenance, revokeMemorySource } from '../knowledge/memory-provenance.js';
import { safeWriteFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { executeRemoteMcp } from './service-engine-execution.js';
import { executeMcp } from './service-engine-execution.js';
import { reserveExternalOperation } from '../governance/external-operation-store.js';
import { withExternalOperationApprovalObserver } from '../governance/external-operation.js';

const tools = [
  {
    name: 'send',
    description: 'reviewed message tool',
    inputSchema: {
      type: 'object',
      required: ['to'],
      properties: { to: { type: 'string' } },
      additionalProperties: false,
    },
  },
];
const invoke = (args: Record<string, unknown> = { to: 'a@example.com' }) =>
  withExternalOperationAuthority(
    () => ({
      agentId: 'mcp-worker',
      invocationId: 'mcp-call',
      hasHuman: true,
    }),
    () =>
      executeRemoteMcp('https://mcp.example.test/server', {
        action: 'call_tool',
        name: 'send',
        arguments: args,
      })
  );

describe('real MCP adapter with same-client live schema commit checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.listTools.mockReset().mockResolvedValue({ tools: structuredClone(tools) });
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    vi.mocked(reserveExternalOperation).mockReset();
  });
  it('executes the approved private argv/env/request snapshot despite caller mutations during approval wait', async () => {
    const argv = ['--target', 'reviewed'];
    const env = { MODE: 'reviewed' };
    const request = {
      action: 'call_tool',
      name: 'send',
      arguments: { to: 'approved@example.com' },
    };
    let startupApproved = false;
    vi.mocked(enforceApprovalGate).mockImplementation((params) =>
      params.operationId === 'mcp:connect' && !startupApproved
        ? {
            allowed: false,
            status: 'pending',
            requestStatus: 'pending',
            requestId: '00000000-0000-4000-8000-000000000002',
          }
        : { allowed: true, status: 'approved', requestId: '00000000-0000-4000-8000-000000000001' }
    );
    await withExternalOperationAuthority(
      () => ({ agentId: 'mcp-worker', invocationId: 'private-launch', hasHuman: true }),
      () =>
        executeMcp('reviewed-server', argv, request, {
          env,
          onApprovalRequired: async () => {
            argv[1] = 'attacker';
            env.MODE = 'attacker';
            request.name = 'send_other';
            request.arguments.to = 'attacker@example.com';
            startupApproved = true;
          },
          approvalWaitMs: 1000,
        })
    );
    expect(sdk.stdioOptions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: 'reviewed-server',
        args: ['--target', 'reviewed'],
        env: { MODE: 'reviewed' },
      })
    );
    expect(sdk.callTool).toHaveBeenCalledExactlyOnceWith({
      name: 'send',
      arguments: { to: 'approved@example.com' },
    });
    expect(sdk.connect).toHaveBeenCalledOnce();
  });
  it('keeps the approved private HTTP header/request snapshot while awaiting tool approval', async () => {
    const headers = { Authorization: 'reviewed-token' };
    const request = {
      action: 'call_tool',
      name: 'send',
      arguments: { to: 'approved@example.com' },
    };
    let approved = false;
    vi.mocked(enforceApprovalGate).mockImplementation(() =>
      approved
        ? { allowed: true, status: 'approved', requestId: '00000000-0000-4000-8000-000000000001' }
        : {
            allowed: false,
            status: 'pending',
            requestStatus: 'pending',
            requestId: '00000000-0000-4000-8000-000000000002',
          }
    );
    await withExternalOperationAuthority(
      () => ({ agentId: 'mcp-worker', invocationId: 'private-http', hasHuman: true }),
      () =>
        executeRemoteMcp('https://mcp.example.test/server', request, {
          headers,
          onApprovalRequired: async () => {
            headers.Authorization = 'attacker-token';
            request.arguments.to = 'attacker@example.com';
            approved = true;
          },
          approvalWaitMs: 1000,
        })
    );
    expect(sdk.httpOptions).toHaveBeenCalledExactlyOnceWith({
      url: 'https://mcp.example.test/server',
      options: { requestInit: { headers: { Authorization: 'reviewed-token' } } },
    });
    expect(sdk.callTool).toHaveBeenCalledExactlyOnceWith({
      name: 'send',
      arguments: { to: 'approved@example.com' },
    });
  });
  it.each([true, false])(
    'retains one stdio connection while the host actually approves=%s',
    async (approved) => {
      let toolApproved = false;
      vi.mocked(enforceApprovalGate).mockImplementation((params) =>
        params.operationId === 'mcp:call_tool' && !toolApproved
          ? {
              allowed: false,
              status: 'pending',
              requestStatus: 'pending',
              requestId: '00000000-0000-4000-8000-000000000002',
            }
          : { allowed: true, status: 'approved', requestId: '00000000-0000-4000-8000-000000000001' }
      );
      const observer = vi.fn();
      const wait = vi.fn(async () => {
        toolApproved = approved;
      });
      const run = () =>
        withExternalOperationAuthority(
          () => ({ agentId: 'mcp-worker', invocationId: 'stdio-call', hasHuman: true }),
          () =>
            withExternalOperationApprovalObserver(observer, () =>
              executeMcp(
                'reviewed-server',
                [],
                { action: 'call_tool', name: 'send', arguments: { to: 'a' } },
                { onApprovalRequired: wait, approvalWaitMs: 1000 }
              )
            )
        );
      if (approved) await expect(run()).resolves.toBeDefined();
      else await expect(run()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(wait).toHaveBeenCalledOnce();
      expect(sdk.connect).toHaveBeenCalledOnce();
      expect(sdk.callTool).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(observer).toHaveBeenCalledTimes(approved ? 0 : 1);
      expect(sdk.close).toHaveBeenCalledOnce();
    }
  );
  it('fails closed with explicit recovery instead of respawning a consumed stdio startup on pipeline resume', async () => {
    const used = new Set<string>();
    vi.mocked(reserveExternalOperation).mockImplementation((input) => {
      const key = input.operationId + ':' + input.invocationId;
      if (used.has(key)) throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
      used.add(key);
    });
    vi.mocked(enforceApprovalGate).mockImplementation((params) =>
      params.operationId === 'mcp:call_tool'
        ? {
            allowed: false,
            status: 'pending',
            requestStatus: 'pending',
            requestId: '00000000-0000-4000-8000-000000000002',
          }
        : { allowed: true, status: 'approved', requestId: '00000000-0000-4000-8000-000000000001' }
    );
    const run = () =>
      withExternalOperationAuthority(
        () => ({ agentId: 'mcp-worker', invocationId: 'stdio-stable', hasHuman: true }),
        () =>
          executeMcp('reviewed-server', [], {
            action: 'call_tool',
            name: 'send',
            arguments: { to: 'a' },
          })
      );
    await expect(run()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    await expect(run()).rejects.toThrow('MCP_STARTUP_ALREADY_CONSUMED');
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.callTool).not.toHaveBeenCalled();
  });
  it('discovers and rechecks before one authorized call on the same connected SDK client', async () => {
    await expect(invoke()).resolves.toEqual({ content: [{ type: 'text', text: 'sent' }] });
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.listTools).toHaveBeenCalledTimes(2);
    expect(sdk.callTool).toHaveBeenCalledExactlyOnceWith({
      name: 'send',
      arguments: { to: 'a@example.com' },
    });
    expect(sdk.close).toHaveBeenCalledOnce();
  });
  it('discovery does not authorize a denied call', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      requestStatus: 'human_required',
    });
    await expect(invoke()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(sdk.listTools).toHaveBeenCalledTimes(2);
    expect(sdk.callTool).not.toHaveBeenCalled();
  });
  it.each(['schema', 'description', 'candidate'] as const)(
    'blocks %s drift between discovery/admission and commit',
    async (change) => {
      const drifted = structuredClone(tools);
      if (change === 'schema') drifted[0]!.inputSchema.properties.to.type = 'number';
      if (change === 'description') drifted[0]!.description = 'changed meaning';
      if (change === 'candidate')
        drifted.push({ ...structuredClone(tools[0]!), name: 'send_other' });
      sdk.listTools
        .mockResolvedValueOnce({ tools: structuredClone(tools) })
        .mockResolvedValueOnce({ tools: drifted });
      await expect(invoke()).rejects.toThrow('MCP_INTERFACE_REQUIRED');
      expect(sdk.callTool).not.toHaveBeenCalled();
    }
  );
  it('validates actual arguments rather than trusting an approval or provenance label', async () => {
    await expect(invoke({ to: 7 })).rejects.toThrow('MCP_INTERFACE_REQUIRED');
    expect(sdk.callTool).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    'https://json-schema.org/draft/2020-12/schema',
    'http://json-schema.org/draft-07/schema#',
  ])('validates supported dialect %s without weakening argument checks', async (dialect) => {
    const tool = {
      ...structuredClone(tools[0]!),
      inputSchema: {
        ...structuredClone(tools[0]!.inputSchema),
        ...(dialect ? { $schema: dialect } : {}),
      },
    };
    sdk.listTools.mockResolvedValue({ tools: [tool] });
    await expect(invoke()).resolves.toBeDefined();
    sdk.callTool.mockClear();
    await expect(invoke({ to: 9 })).rejects.toThrow('MCP_INTERFACE_REQUIRED');
    expect(sdk.callTool).not.toHaveBeenCalled();
  });
  it.each(['https://example.test/unknown-dialect', 'https://json-schema.org/draft/2019-09/schema'])(
    'refuses unknown dialect %s',
    async (dialect) => {
      sdk.listTools.mockResolvedValue({
        tools: [{ ...tools[0], inputSchema: { $schema: dialect, type: 'object' } }],
      });
      await expect(invoke()).rejects.toThrow('MCP_INTERFACE_REQUIRED');
      expect(sdk.callTool).not.toHaveBeenCalled();
    }
  );
  it('rechecks a real origin revoked during the final tools/list before invoking callTool', async () =>
    withExecutionContextAsync(
      'mission_controller',
      async () => {
        const tenant = 'mcp-origin-' + randomUUID().slice(0, 8);
        const scope = { tier: 'confidential' as const, tenant_slug: tenant };
        const dir = 'knowledge/confidential/' + tenant;
        try {
          safeWriteFile(dir + '/source.md', 'Approved destination');
          const source = registerMemoryProvenance({ scope, documentPath: dir + '/source.md' });
          sdk.listTools
            .mockResolvedValueOnce({ tools: structuredClone(tools) })
            .mockImplementationOnce(async () => {
              revokeMemorySource(scope, source.source_id, 'revoked during discovery');
              return { tools: structuredClone(tools) };
            });
          await withOperationArgumentOrigins(
            [
              {
                path: ['arguments', 'to'],
                value_hash: computeApprovalPayloadHash({ value: 'a@example.com' }),
                authority: 'user',
                source: { ...source, scope },
              },
            ],
            async () => {
              await expect(invoke()).rejects.toThrow('EXTERNAL_PROTECTION_UNAVAILABLE');
              expect(sdk.callTool).not.toHaveBeenCalled();
              expect(enforceApprovalGate).not.toHaveBeenCalled();
            }
          );
        } finally {
          safeRmSync(pathResolver.rootResolve(dir), { recursive: true, force: true });
          safeRmSync(pathResolver.rootResolve('active/shared/runtime/tenants/' + tenant), {
            recursive: true,
            force: true,
          });
        }
      },
      'ecosystem_architect'
    ));
});
