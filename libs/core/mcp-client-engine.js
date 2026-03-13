"use strict";
/**
 * scripts/mcp-client-engine.ts
 * Common logic for MCP client wrappers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeMcp = executeMcp;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
async function executeMcp(command, args, actionRequest) {
    const transport = new stdio_js_1.StdioClientTransport({
        command,
        args,
        stderr: "inherit",
    });
    const client = new index_js_1.Client({
        name: "Kyberion-Connector-Client",
        version: "1.0.0",
    }, {
        capabilities: {},
    });
    try {
        await client.connect(transport);
        let result;
        if (actionRequest.action === 'list_tools') {
            result = await client.listTools();
        }
        else if (actionRequest.action === 'call_tool') {
            if (!actionRequest.name)
                throw new Error("Tool name is required for call_tool");
            result = await client.callTool({
                name: actionRequest.name,
                arguments: actionRequest.arguments || {},
            });
        }
        else if (actionRequest.action === 'list_resources') {
            result = await client.listResources();
        }
        else {
            throw new Error(`Unsupported action: ${actionRequest.action}`);
        }
        return result;
    }
    finally {
        try {
            await transport.close();
        }
        catch (e) { }
    }
}
//# sourceMappingURL=mcp-client-engine.js.map