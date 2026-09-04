import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './config_mission.js';

describe('config mission CLI output boundary', () => {
  it('keeps config mission output free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/config_mission.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes help output through the supplied printer', async () => {
    const output: unknown[] = [];

    await main(['help'], (value) => output.push(value));

    expect(output.join('\n')).toContain('Usage: pnpm config-mission');
  });
});
