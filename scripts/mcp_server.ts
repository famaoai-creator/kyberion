/**
 * Kyberion MCP Server — stdio entry point (Phase 0)
 *
 * Start with:  pnpm mcp:server
 * Or compiled: node dist/scripts/mcp_server.js
 *
 * Cowork connector config (Claude Desktop / MCP client):
 *   {
 *     "kyberion": {
 *       "command": "node",
 *       "args": ["<REPO>/dist/scripts/mcp_server.js"],
 *       "cwd": "<REPO>"
 *     }
 *   }
 */

import { startMcpServerStdio } from '@agent/shared-network';

startMcpServerStdio().catch((err) => {
  process.stderr.write(`Kyberion MCP server fatal error: ${err}\n`);
  process.exit(1);
});
