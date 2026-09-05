import { describe, expect, it } from 'vitest';
import {
  checkChannelAdapterAdoption,
  hasSharedThreadFormatterImport,
} from './check_channel_adapter_adoption.js';

describe('channel adapter adoption checker', () => {
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
