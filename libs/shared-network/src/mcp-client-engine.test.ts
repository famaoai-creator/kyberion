import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeMcp } from './mcp-client-engine.js';

const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const Client = vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
    this.listResources = vi.fn().mockResolvedValue({ resources: [] });
  });
  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  const StdioClientTransport = vi.fn(function (this: any) {
    this.close = mockClose;
  });
  return { StdioClientTransport };
});

describe('executeMcp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_toolsアクションでclient.listTools()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], { action: 'list_tools' });
    expect(mockListTools).toHaveBeenCalledOnce();
  });

  it('call_toolアクションでname未指定の場合エラーをスロー', async () => {
    await expect(executeMcp('node', ['server.js'], { action: 'call_tool' })).rejects.toThrow(
      'Tool name is required'
    );
  });

  it('call_toolアクションでname指定の場合client.callTool()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], {
      action: 'call_tool',
      name: 'my-tool',
      arguments: { key: 'value' },
    });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'my-tool',
      arguments: { key: 'value' },
    });
  });

  it('サポートされていないactionでエラーをスロー', async () => {
    await expect(executeMcp('node', ['server.js'], { action: 'invalid' as any })).rejects.toThrow(
      'Unsupported action'
    );
  });

  it('実行後にtransport.close()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], { action: 'list_tools' });
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
