/**
 * scripts/mcp-client-engine.ts
 * Common logic for MCP client wrappers.
 */
export interface McpActionRequest {
    action: 'list_tools' | 'call_tool' | 'list_resources';
    name?: string;
    arguments?: Record<string, any>;
}
export declare function executeMcp(command: string, args: string[], actionRequest: McpActionRequest): Promise<any>;
//# sourceMappingURL=mcp-client-engine.d.ts.map