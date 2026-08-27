import { describe, expect, it, vi } from 'vitest';

describe('foundation io registration', () => {
  it('fails closed when secure-io has not registered the implementation', async () => {
    const testGlobal = globalThis as typeof globalThis & { __kyberionVitestIo?: unknown };
    const seam = testGlobal.__kyberionVitestIo;
    try {
      delete testGlobal.__kyberionVitestIo;
      vi.resetModules();
      const { getFoundationIo } = await import('./io.js');
      expect(() => getFoundationIo()).toThrow('secure_foundation_io_not_registered');
    } finally {
      testGlobal.__kyberionVitestIo = seam;
    }
  });
});
