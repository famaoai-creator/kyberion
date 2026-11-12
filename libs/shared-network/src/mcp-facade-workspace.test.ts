import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMcpFacadeDiscoverTools } from './mcp-facade-discover.js';
import { mcpWorkspaceViewer, registerMcpFacadeWorkspaceTools } from './mcp-facade-workspace.js';
import { resolveMcpRequestContext } from './mcp-request-context.js';

describe('MCP workspace facade', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('registers every surface operation as a kyberion.* tool', () => {
    const names: string[] = [];
    registerMcpFacadeWorkspaceTools({
      server: {} as never,
      catalog: {} as never,
      registerGovernedTool: ((_s: unknown, _c: unknown, name: string) => names.push(name)) as never,
    });
    expect(names).toEqual([
      'kyberion.workspace.summary',
      'kyberion.workspace.list',
      'kyberion.workspace.get',
      'kyberion.workspace.search',
      'kyberion.setup.checklist',
      'kyberion.needs-you.list',
      'kyberion.needs-you.summary',
    ]);
  });

  it('binds the viewer to the server tenant, or public-only without one', () => {
    vi.stubEnv('KYBERION_MCP_TENANT', '');
    vi.stubEnv('KYBERION_TENANT', '');
    expect(mcpWorkspaceViewer()).toMatchObject({
      role: 'readonly',
      tenantSlugs: [],
      tierAccess: ['public'],
    });
    vi.stubEnv('KYBERION_MCP_TENANT', 'acme');
    expect(mcpWorkspaceViewer()).toMatchObject({
      tenantSlugs: ['acme'],
      tierAccess: ['confidential', 'public'],
    });
  });

  it('uses the request context the governed wrapper already resolved', async () => {
    vi.stubEnv('KYBERION_MCP_TENANT', '');
    vi.stubEnv('KYBERION_TENANT', '');
    const context = resolveMcpRequestContext({
      env: { KYBERION_MCP_TENANT: 'acme', KYBERION_MCP_PRINCIPAL: 'cowork-user' },
    });
    expect(mcpWorkspaceViewer(context)).toMatchObject({
      tenantSlugs: ['acme'],
      tierAccess: ['confidential', 'public'],
      principalId: 'cowork-user',
    });

    const handlers = new Map<string, (args: unknown, context: unknown) => Promise<unknown>>();
    registerMcpFacadeDiscoverTools({
      server: { registerResource: () => undefined } as never,
      catalog: {} as never,
      registerGovernedTool: ((
        _s: unknown,
        _c: unknown,
        name: string,
        _d: unknown,
        _schema: unknown,
        handler: (args: unknown, context: unknown) => Promise<unknown>
      ) => handlers.set(name, handler)) as never,
    });
    const result = (await handlers.get('kyberion.scope.current')!({}, context)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toContain('"acme"');
  });
});
