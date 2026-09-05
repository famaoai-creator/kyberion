import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('dependency vulnerability scan entrypoint', () => {
  it('keeps scan output behind the shared script harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/scan_dependency_vulns.ts'));

    expect(source).toContain('runDependencyVulnerabilityScan = defineScript');
    expect(source).toContain('print(json ? result : formatDependencyVulnerabilityScanSummary');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('logger.warn(');
    expect(source).toContain('readTextFile');
  });
});
