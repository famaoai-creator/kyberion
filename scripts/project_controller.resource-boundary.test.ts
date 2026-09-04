import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { main, parseProjectMetadata } from './project_controller.js';

describe('project controller resource boundaries', () => {
  it('accepts metadata objects and rejects unsafe or non-object JSON', () => {
    expect(parseProjectMetadata('{"owner":"ops"}')).toEqual({ owner: 'ops' });
    expect(() => parseProjectMetadata('[]')).toThrow('--metadata must be a JSON object');
    expect(() => parseProjectMetadata('{"__proto__":{"polluted":true}}')).toThrow(
      '--metadata contains a dangerous JSON key'
    );
  });

  it('routes project CLI output through the harness printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/project_controller.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');

    const output: unknown[] = [];
    await main(['help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('Project controller');
  });
});
