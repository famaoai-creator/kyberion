import { describe, expect, it, vi } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveMeshHubSection, runMeshHubInspect } from './mesh_hub_inspect.js';

describe('mesh hub inspection output boundary', () => {
  it('keeps report output behind the injected printer', () => {
    const source = String(safeReadFile(pathResolver.rootResolve('scripts/mesh_hub_inspect.ts')));

    expect(source).toContain('print: Print');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
  });
});

describe('mesh hub inspection section', () => {
  it('accepts the supported sections', () => {
    for (const section of ['all', 'peers', 'routes', 'deliveries', 'dead-letters']) {
      expect(resolveMeshHubSection(section)).toBe(section);
    }
    expect(resolveMeshHubSection(undefined)).toBe('all');
  });

  it('refuses the retired topics view with a clear error', () => {
    expect(() => resolveMeshHubSection('topics')).toThrow(/topics view was retired/);
  });

  it('refuses an unknown section instead of printing the full report', () => {
    expect(() => resolveMeshHubSection('bogus')).toThrow(/unknown section 'bogus'/);
  });

  it('rejects a positional topics section before inspecting the hub', async () => {
    const print = vi.fn();
    await expect(runMeshHubInspect(['topics', '--tenant-id', 'acme'], print)).rejects.toThrow(
      /topics view was retired/
    );
    expect(print).not.toHaveBeenCalled();
  });
});
