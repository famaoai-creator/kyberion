import { describe, expect, it, vi } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { main, readReasoningConfigTextFile } from './reasoning_config.js';

vi.mock('@agent/core/reasoning/reasoning-route-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-route-resolver')>()),
  loadReasoningRoutePolicy: () => ({
    roles: { default: {}, context_compaction: {}, background_review: {} },
  }),
  resolveReasoningRoute: () => ({
    role: 'default',
    profileRef: 'fixture-main',
    mode: 'stub',
    model: 'fixture-model',
    candidates: ['fixture-main'],
    capabilities: ['text'],
    provenance: [],
    rejectedCandidates: [],
  }),
}));

describe('reasoning config entrypoint', () => {
  it('shows requested and inherited effective identities in explain JSON and text', async () => {
    for (const role of ['context_compaction', 'background_review']) {
      const print = vi.fn();
      await main(['explain', '--role', role], print, { json: true });
      expect(print).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'default',
          requestedRole: role,
          effectiveRole: 'default',
          inheritsDefault: true,
        })
      );
      print.mockClear();
      await main(['explain', '--role', role], print);
      expect(print).toHaveBeenCalledWith(
        expect.stringContaining(`role=${role} inherits=default effective_role=default`)
      );
    }
  });

  it('lists each requested auxiliary role instead of repeating the default label', async () => {
    const print = vi.fn();
    await main(['list'], print);
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('context_compaction (inherits default): fixture-main')
    );
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('background_review (inherits default): fixture-main')
    );
    print.mockClear();
    await main(['list'], print, { json: true });
    expect(
      print.mock.calls[0]?.[0].routes.map((route: { requestedRole: string }) => route.requestedRole)
    ).toEqual(['default', 'context_compaction', 'background_review']);
  });

  it('keeps route output and mutation policy behind the shared script harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/reasoning_config.ts'));

    expect(source).toContain("flags: ['json', 'dry-run', 'check', 'quiet']");
    expect(source).toContain('run: async ({ argv, print, json, dryRun, check })');
    expect(source).toContain('main(argv, print, { json, dryRun, check })');
    expect(source).toContain('new ScriptExitError');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('commitReasoningRouteConfig');
    expect(source).toContain('saveReasoningSelection');
  });

  it('rejects a directory before reading the previous route config', () => {
    expect(() => readReasoningConfigTextFile(pathResolver.rootResolve('knowledge'))).toThrow(
      'must be a regular file'
    );
  });
});
