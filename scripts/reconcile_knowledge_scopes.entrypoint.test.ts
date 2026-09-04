import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('knowledge scope reconciliation entrypoint', () => {
  it('uses the shared harness output flags and printer', () => {
    const source = readFileSync(resolve('scripts/reconcile_knowledge_scopes.ts'), 'utf8');

    expect(source).toContain("flags: ['json', 'quiet']");
    expect(source).toContain('json, quiet, print');
    expect(source).toContain('if (json) print(report)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.warn(');
  });
});
