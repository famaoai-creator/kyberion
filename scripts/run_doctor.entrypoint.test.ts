import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('doctor entrypoint', () => {
  it('keeps report formatting and shared flags behind the common harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_doctor.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('function normalizeDoctorArguments(args: string[]): string[]');
    expect(source).toContain('export function formatDoctorReport(');
    expect(source).toContain(
      'context.print(context.json ? report : formatDoctorReport(report, argv));'
    );
    expect(source).toContain('stripSharedScriptFlags(args)');
    expect(source).not.toContain('flags: []');
    expect(source).not.toContain('process.exitCode =');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.env.MISSION_ID ||');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });
});
