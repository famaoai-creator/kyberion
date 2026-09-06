import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { printServiceSetupReport } from './services_setup.js';

describe('services setup output boundary', () => {
  it('keeps service setup reporting free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/services_setup.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes service setup reporting through the supplied printer', () => {
    const output: unknown[] = [];

    printServiceSetupReport(
      [],
      {
        total: 0,
        ready: 0,
        authMissing: 0,
        connectionMissing: 0,
        customerConnections: 0,
        personalConnections: 0,
      },
      { configured: false, env_var: 'KYBERION_OPS_ALERT_WEBHOOK' },
      (value) => output.push(value)
    );

    expect(output.join('\n')).toContain('SERVICE');
    expect(output.join('\n')).toContain('OPS ALERTS');
  });
});
