import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkExtensionOrder, readExtensionOrderTextFile } from './check_extension_order.js';

describe('extension order checker', () => {
  it('rejects a directory replacement before lifecycle parsing', () => {
    expect(() => readExtensionOrderTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for the extension document', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_extension_order.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('validates the lifecycle document without executing on import', () => {
    expect(checkExtensionOrder()).toEqual({ runtimeEvents: 15 });
  });
});
