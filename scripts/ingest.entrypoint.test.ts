import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './ingest.js';

describe('ingest CLI output boundary', () => {
  it('keeps the ingest ceremony free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/ingest.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain("getRegisteredEnvText('MISSION_ROLE')");
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes help output through the supplied printer', async () => {
    const output: unknown[] = [];

    await main(['--help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('DA-05 explicit ingest ceremony');
  });
});
