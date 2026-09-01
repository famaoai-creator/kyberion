import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('action item reminder entrypoint', () => {
  it('keeps reminder output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/action_item_reminders.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(report)');
    expect(source).not.toContain('console.log(');
  });
});
