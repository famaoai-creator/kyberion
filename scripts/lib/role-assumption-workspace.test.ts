import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  collectSystemRoleEntries,
  createWorkspace,
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

  it('follows the app sources when a surface launches the workspace Next.js binary', () => {
    const files = collectSystemRoleEntries(ws).get('concierge') ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => ws.rel(file).startsWith('presence/displays/concierge/'))).toBe(
      true
    );
    expect(files.some((file) => ws.rel(file).includes('/src/app/'))).toBe(true);
    expect(files.some((file) => ws.rel(file).includes('node_modules/'))).toBe(false);
  });
});
