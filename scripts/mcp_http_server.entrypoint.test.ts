import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptContext } from './lib/harness.js';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  compose: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@agent/shared-network', () => ({ createMcpHttpRuntime: mocks.compose }));
vi.mock('@agent/core/surface/human-request-runtime-config', () => ({
  loadHumanRequestRuntimeConfig: mocks.load,
}));
import { runMcpHttpServerCommand } from './mcp_http_server.js';
function context(argv: string[]): ScriptContext {
  return {
    name: 'test',
    argv,
    json: false,
    quiet: true,
    positional: [],
    unknownFlags: [],
    check: argv.includes('--check'),
    dryRun: argv.includes('--dry-run'),
    print: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({ version: 1 });
  mocks.compose.mockReturnValue({ enabled: false, start: mocks.start });
  mocks.close.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ close: mocks.close, closed: Promise.resolve('closed') });
});
describe('HTTP MCP explicit entrypoint', () => {
  it.each([['--check'], ['--dry-run'], ['--start', '--check']])(
    'validates without listening for %s',
    async (...argv) => {
      const ctx = context(argv);
      const result = await runMcpHttpServerCommand(ctx);
      expect(mocks.load).toHaveBeenCalledWith(undefined);
      expect(mocks.compose).toHaveBeenCalledWith({ version: 1 });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        listening: false,
        external_tls_verified: false,
        provider_verified: false,
      });
    }
  );
  it('uses the explicit config path and exposes no config contents', async () => {
    const ctx = context(['--check', '--config', '/synthetic/config.json']);
    await runMcpHttpServerCommand(ctx);
    expect(mocks.load).toHaveBeenCalledWith('/synthetic/config.json');
    expect(JSON.stringify(vi.mocked(ctx.print).mock.calls)).not.toContain('/synthetic');
  });
  it.each([[], ['--config'], ['--listen'], ['--start', '--start'], ['--check', 'junk']])(
    'rejects implicit or unknown startup arguments %j',
    async (...argv) => {
      await expect(runMcpHttpServerCommand(context(argv))).rejects.toThrow(
        'Use --check or --start'
      );
      expect(mocks.start).not.toHaveBeenCalled();
    }
  );
  it('starts only on explicit request, awaits closure and removes signal listeners', async () => {
    const before = process.listenerCount('SIGTERM');
    await runMcpHttpServerCommand(context(['--start']));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('handles asynchronous listener failure without exposing provider/config data', async () => {
    mocks.start.mockResolvedValue({ close: mocks.close, closed: Promise.resolve('failed') });
    await expect(runMcpHttpServerCommand(context(['--start']))).rejects.toThrow(
      'HTTP MCP listener failed'
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
