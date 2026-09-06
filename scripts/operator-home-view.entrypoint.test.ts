import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { printCommands } from './operator-home-view.js';

describe('operator home view output boundary', () => {
  it('routes home view output through the supplied printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/operator-home-view.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('printCommands(ui, print)');
  });

  it('uses the supplied printer for the command list', () => {
    const output: unknown[] = [];
    printCommands(
      (key) => key,
      (value) => output.push(value)
    );
    expect(output).toContain('recorder:recorder_commands_header');
    expect(output).toContain('  Registered user commands:');
    expect(output.some((line) => String(line).includes('pnpm kyberion'))).toBe(true);
  });
});
