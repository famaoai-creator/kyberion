import * as nodePath from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { safeChildEnv } from '../foundation/env.js';
import { pathResolver } from '../path-resolver.js';

/** Transport configuration is independent of SDK tool-policy execution. */
export function buildKyberionMcpServerConfig(
  repoRoot: string = pathResolver.rootDir()
): Record<string, McpServerConfig> {
  return {
    kyberion: {
      type: 'stdio',
      command: 'node',
      args: [nodePath.join(repoRoot, 'dist/scripts/mcp_server.js')],
      cwd: repoRoot,
      env: { KYBERION_PERSONA: safeChildEnv().KYBERION_PERSONA ?? 'sovereign_concierge' },
    } as McpServerConfig,
  };
}
