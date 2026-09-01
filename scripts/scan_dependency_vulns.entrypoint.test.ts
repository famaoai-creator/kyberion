import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('dependency vulnerability scan entrypoint', () => {
  it('keeps scan output behind the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/scan_dependency_vulns.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('runDependencyVulnerabilityScan = defineScript');
    expect(source).toContain('print(json ? result : formatDependencyVulnerabilityScanSummary');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('logger.warn(');
  });
});
