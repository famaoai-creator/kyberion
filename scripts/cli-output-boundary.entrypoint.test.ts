import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './cli.js';

describe('CLI output boundary', () => {
  it('keeps CLI command output away from direct process streams', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('activeCliPrint');
    expect(source).toContain('printText');
  });

  it('routes command output through the supplied printer', async () => {
    const output: unknown[] = [];

    await main(['schedule', 'list'], (value) => output.push(value));

    expect(output.join('\n')).toMatch(/Scheduled Pipelines|No scheduled pipelines/);
  });
});
