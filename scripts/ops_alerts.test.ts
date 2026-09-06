import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('ops alerts entrypoint', () => {
  it('keeps triage output behind the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/ops_alerts.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('runOpsAlerts = defineScript');
    expect(source).toContain('print(formatOpsAlertSummary(summary).join');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('logger.warn(');
  });
});
