import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('terminal HUD entrypoint', () => {
  it('keeps argv ownership in the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/terminal-hud/src/main.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      "import { defineScript, isDirectScript } from '@agent/core/script-harness'"
    );
    expect(source).toContain('export async function main(args: string[] = [])');
    expect(source).not.toContain('process.argv');
    expect(source).not.toContain('main().catch(');
  });

  it('passes dev-mode arguments to the package entry instead of mutating process argv', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tui.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain("await runTerminalHud(args.filter((arg) => arg !== '--dev'));");
    expect(source).not.toContain('setCurrentProcessArgv(');
  });
});
