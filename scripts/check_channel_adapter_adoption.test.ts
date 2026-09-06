import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkChannelAdapterAdoption,
  hasSharedThreadFormatterImport,
  readChannelAdapterTextFile,
} from './check_channel_adapter_adoption.js';

describe('channel adapter adoption checker', () => {
  it('rejects a directory replacement before bridge parsing', () => {
    expect(() => readChannelAdapterTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for bridge source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_channel_adapter_adoption.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('requires the shared thread formatter to be imported from the canonical module', () => {
    expect(
      hasSharedThreadFormatterImport(
        "import { formatChannelThreadContext } from '@agent/core/channel-adapter';"
      )
    ).toBe(true);
    expect(
      hasSharedThreadFormatterImport(
        'function formatChannelThreadContext() {}\nformatChannelThreadContext();'
      )
    ).toBe(false);
  });

  it('keeps every supported bridge behind the shared formatter gate', () => {
    expect(checkChannelAdapterAdoption()).toEqual([]);
  });
});
