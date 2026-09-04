import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { printHeader, withPresentationOutputPrinter } from './cli-presentation.js';

describe('CLI presentation output boundary', () => {
  it('keeps presentation rendering free of direct process output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli-presentation.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('withPresentationOutputPrinter');
  });

  it('routes presentation output through the injected printer', async () => {
    const output: unknown[] = [];

    await withPresentationOutputPrinter(
      (value) => output.push(value),
      () => printHeader('en')
    );

    expect(output).toHaveLength(2);
    expect(output.join('\n')).toContain('KYBERION CONSOLE');
  });
});
