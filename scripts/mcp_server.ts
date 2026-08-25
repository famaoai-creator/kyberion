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
import { defineScript, isDirectScript } from './lib/harness.js';

export const runMcpServer = defineScript({
  name: 'mcp:server',
  flags: [],
  async run() {
    await startMcpServerStdio();
  },
});

if (
  isDirectScript(import.meta.url, 'mcp_server.ts') ||
  isDirectScript(import.meta.url, 'mcp_server.js')
)
  void runMcpServer();
