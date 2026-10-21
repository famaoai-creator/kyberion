import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  root: '/mock/root',
  define: vi.fn(),
  load: vi.fn(),
  path: vi.fn(),
}));
vi.mock('./foundation/governed-catalog.js', () => ({ defineCatalog: boundary.define }));
vi.mock('./path-resolver.js', () => ({
  pathResolver: { knowledge: boundary.path },
}));

beforeEach(() => {
  vi.resetModules();
  boundary.root = '/mock/root';
  boundary.path
    .mockReset()
    .mockImplementation((relative: string) => `${boundary.root}/knowledge/${relative}`);
  boundary.define.mockReset().mockImplementation(() => ({ load: boundary.load }));
  boundary.load.mockReset().mockImplementation(() => {
    throw new Error('missing policy');
  });
});

describe('runtime policy operation boundary', () => {
  it('does not resolve paths, construct a catalog or read policy during cold import', async () => {
    await import('./runtime-control-policy.js');
    expect(boundary.path).not.toHaveBeenCalled();
    expect(boundary.define).not.toHaveBeenCalled();
    expect(boundary.load).not.toHaveBeenCalled();
  });

  it('propagates missing or invalid policy at use without a production fallback', async () => {
    const { loadRuntimeControlPolicy } = await import('./runtime-control-policy.js');
    expect(() => loadRuntimeControlPolicy()).toThrow('missing policy');
    expect(boundary.define).toHaveBeenCalledTimes(1);
    boundary.load.mockImplementation(() => {
      throw new Error('invalid policy');
    });
    expect(() => loadRuntimeControlPolicy()).toThrow('invalid policy');
  });

  it('resolves both catalog and schema against the root active at actual use', async () => {
    const { loadRuntimeControlPolicy } = await import('./runtime-control-policy.js');
    boundary.load.mockReturnValue({ version: 1 });
    loadRuntimeControlPolicy();
    boundary.root = '/second/root';
    loadRuntimeControlPolicy();
    expect(boundary.define).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/second/root/knowledge/product/governance/runtime-control-policy.json',
        schema: '/second/root/knowledge/product/schemas/runtime-control-policy.schema.json',
      })
    );
  });
});
