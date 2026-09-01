import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('setup report entrypoint', () => {
  it('keeps human and JSON output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/setup_report.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain(
      'function formatSetupReport(report: SetupReport, persona: SetupPersona)'
    );
    expect(source).toContain("print(json ? { status: 'ok', report: result.report } :");
    expect(source).toContain("const normalizedArgs = args.filter((arg) => arg !== '--');");
    expect(source).toContain('runReasoningSetup({ quiet })');
    expect(source).toContain('const quiet = options.quiet ?? options.persona ===');
    expect(source).toContain('main(argv, quiet || json)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('flags: []');
  });
});
