/**
 * scripts/mcp-client-engine.ts
 * Common logic for MCP client wrappers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpActionRequest {
  action: 'list_tools' | 'call_tool' | 'list_resources';
  name?: string;
  arguments?: Record<string, any>;
}

export async function executeMcp(command: string, args: string[], actionRequest: McpActionRequest) {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "inherit",
  });

  const client = new Client(
    {
      name: "Kyberion-Connector-Client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);

    let result;
    if (actionRequest.action === 'list_tools') {
      result = await client.listTools();
    } else if (actionRequest.action === 'call_tool') {
      if (!actionRequest.name) throw new Error("Tool name is required for call_tool");
      result = await client.callTool({
        name: actionRequest.name,
        arguments: actionRequest.arguments || {},
      });
    } else if (actionRequest.action === 'list_resources') {
      result = await client.listResources();
    } else {
      throw new Error(`Unsupported action: ${actionRequest.action}`);
    }

    return result;
  } finally {
    try {
      await transport.close();
    } catch (e) {}
  }
}
