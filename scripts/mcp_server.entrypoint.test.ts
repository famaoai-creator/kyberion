import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('MCP server entrypoint', () => {
  it('keeps the stdio server behind the shared harness without protocol stdout', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mcp_server.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("name: 'mcp:server'");
    expect(source).not.toContain('flags: []');
    expect(source).not.toContain('console.log(');
    expect(source).toContain('if (dryRun || check)');
    expect(source).toContain("operation: 'mcp-server.connect-stdio'");
    expect(source).toContain('print(result);');
  });
});
