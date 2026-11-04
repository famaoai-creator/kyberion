import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpWorkspaceViewer, registerMcpFacadeWorkspaceTools } from './mcp-facade-workspace.js';

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
});
