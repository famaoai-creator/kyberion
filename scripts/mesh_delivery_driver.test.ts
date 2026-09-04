import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({
  runMeshDeliveryPass: vi.fn(async () => ({
    claimed: 1,
    delivered: 1,
    failed: 0,
    skipped: 0,
    failures: [],
  })),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core/mesh-delivery-driver', () => ({
  runMeshDeliveryPass: mocks.runMeshDeliveryPass,
  formatMeshDeliveryPassReport: vi.fn(() => 'mesh delivery report'),
}));

vi.mock('@agent/core/core', () => ({
  logger: mocks.logger,
}));

import { runMeshDeliveryDriverOnce } from './mesh_delivery_driver.js';

describe('mesh_delivery_driver', () => {
  it('routes JSON output through the supplied printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mesh_delivery_driver.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');

    const print = vi.fn();
    const report = await runMeshDeliveryDriverOnce({
      senderPeerId: 'peer-a',
      batchLimit: 10,
      json: true,
      print,
    });

    expect(print).toHaveBeenCalledWith(report);
    expect(mocks.runMeshDeliveryPass).toHaveBeenCalledWith({
      senderPeerId: 'peer-a',
      sharedSecret: undefined,
      batchLimit: 10,
    });
  });
});
