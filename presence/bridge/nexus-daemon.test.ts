import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('nexus daemon resource boundaries', () => {
  it('validates daemon JSON and runtime paths before access', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/bridge/nexus-daemon.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('assertSafeRepositoryPath');
    expect(source).toContain('Nexus JSON resource must be an existing regular file');
    expect(source).toContain('function isExistingRegularFile(filePath: string): boolean');
    expect(source).toContain('function parseNexusDispatchResult(value: unknown)');
    expect(source).toContain('parseNexusBrainProfileRegistry(readNexusJson(safeRegistryPath))');
    expect(source).toContain('parseNexusSessionMetadata(readNexusJson(metaPath))');
    expect(source).toContain('parseNexusSessionResponse(readNexusJson(responsePath))');
    expect(source).toContain(
      `const result = parseNexusDispatchResult(
        parseSafeJsonInput(output, 'Nexus actuator response')
      )`
    );
    expect(source).toContain('safeLstat(safeNexusPath(path.join(runtimeBase, sid)))');
    expect(source).toContain("safeNexusPath(path.join(outDir, 'latest_metadata.json'), true)");
  });
});
