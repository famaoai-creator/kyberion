import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('modeling preset resource boundary', () => {
  it('revalidates the browser execution preset catalog before loading it', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'libs/actuators/modeling-actuator/src/modeling-pipeline-helpers.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('defineCatalog<BrowserExecutionPresetCatalog>({');
    expect(source).toContain("id: 'browser-execution-presets'");
    expect(source).toContain('schema: BROWSER_EXECUTION_PRESETS_SCHEMA_PATH');
    expect(source).toContain('browserExecutionPresetCatalog.load()');
    expect(source).not.toContain('FALLBACK_BROWSER_EXECUTION_PRESETS');
    expect(source).not.toContain('fallbackOnInvalid: true');
  });
});
