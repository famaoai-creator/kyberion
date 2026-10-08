import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  collectSystemRoleEntries,
  createWorkspace,
  createResolver,
  createProgram,
  isProjectSource,
  sourceForScriptReference,
} from './role-assumption-workspace.js';

describe('role-assumption workspace entry points', () => {
  const ws = createWorkspace(pathResolver.rootDir());

  it('maps a workspace package dist/ reference to its src/ TypeScript source', () => {
    expect(sourceForScriptReference(ws, 'presence/displays/terminal-hud/dist/index.js')).toBe(
      ws.abs('presence/displays/terminal-hud/src/index.ts')
    );
  });

  it('resolves operator-launched surfaces declared as `pnpm <script>` or a package dist entry', () => {
    const entries = collectSystemRoleEntries(ws);
    expect(entries.get('personal_pads')?.map((file) => ws.rel(file))).toEqual([
      'scripts/personal-pads/server.ts',
    ]);
    expect(entries.get('terminal_hud')?.map((file) => ws.rel(file))).toEqual([
      'presence/displays/terminal-hud/src/index.ts',
    ]);
  });

  it('includes the custom Node server and dynamically discovered Next routes', () => {
    const files = collectSystemRoleEntries(ws).get('concierge') ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => ws.rel(file).startsWith('presence/displays/concierge/'))).toBe(
      true
    );
    const relative = files.map((file) => ws.rel(file));
    expect(relative).toEqual(
      expect.arrayContaining([
        'presence/displays/concierge/server/local-server.ts',
        'presence/displays/concierge/server/local-peer.ts',
        'presence/displays/concierge/src/middleware.ts',
        'presence/displays/concierge/src/app/api/services/operator/route.ts',
        'presence/displays/concierge/src/app/api/headless/manifest/route.ts',
      ])
    );
    expect(relative.some((file) => /\.d\.[cm]?ts$/.test(file))).toBe(false);
    expect(relative.some((file) => file.includes('/.next/') || file.includes('/dist/'))).toBe(
      false
    );
    expect(relative.some((file) => /\.(test|spec)\./.test(file))).toBe(false);
    expect(files.some((file) => ws.rel(file).includes('node_modules/'))).toBe(false);
  });
  it('resolves actual native TypeScript sources from the declared cwd and in the TypeScript program', () => {
    const cwd = ws.abs('presence/displays/concierge');
    const server = ws.abs('presence/displays/concierge/server/local-server.ts');
    const peer = ws.abs('presence/displays/concierge/server/local-peer.ts');
    expect(sourceForScriptReference(ws, 'server/local-server.ts', cwd)).toBe(server);
    const resolve = createResolver(ws);
    expect(resolve('./local-peer.ts', server)).toBe(peer);
    const program = createProgram(ws, [server], resolve);
    expect(program.getSourceFile(server)?.fileName).toBe(server);
    expect(program.getSourceFile(peer)?.fileName).toBe(peer);
  });

  it('excludes outside, dependency, declaration, and generated files', () => {
    for (const file of [
      '../outside.mjs',
      'node_modules/example/index.js',
      'dist/index.js',
      'presence/displays/concierge/.next/server/app.js',
      'presence/displays/concierge/server/local-peer.d.mts',
      'presence/displays/concierge/server/types.d.cts',
      'presence/displays/concierge/next-env.d.ts',
    ]) {
      expect(isProjectSource(ws, ws.abs(file)), file).toBe(false);
    }
    expect(sourceForScriptReference(ws, '../outside.mjs')).toBeNull();
    expect(
      createResolver(ws)(
        '../../../../../../outside.mjs',
        ws.abs('presence/displays/concierge/server/local-server.ts')
      )
    ).toBeNull();
  });
});
