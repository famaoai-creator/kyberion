import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const factory = vi.hoisted(() => vi.fn());
vi.mock('./obs-video-filter-provider.js', () => ({ createObsVideoFilterProvider: factory }));
import { installBuiltinVideoFilterProviders } from './video-filter-bootstrap.js';
import {
  listVideoFilterProviders,
  registerVideoFilterProvider,
  resetVideoFilterProviders,
  type VideoFilterProvider,
} from './video-filter.js';

const provider = (): VideoFilterProvider => ({
  provider_id: 'obs',
  capabilities: { filter_types: ['crop'], local_only: true },
  probe: async () => ({ available: false }),
  list: async () => [],
  prepareApply: async () => {
    throw new Error('not used');
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  factory.mockImplementation(provider);
});
afterEach(resetVideoFilterProviders);
describe('video filter host composition', () => {
  it('preserves a host-installed provider and is repeatable after registry reset', () => {
    const host = provider();
    registerVideoFilterProvider(host);
    installBuiltinVideoFilterProviders();
    expect(factory).not.toHaveBeenCalled();
    expect(listVideoFilterProviders()).toEqual([host]);
    resetVideoFilterProviders();
    installBuiltinVideoFilterProviders();
    installBuiltinVideoFilterProviders();
    expect(factory).toHaveBeenCalledOnce();
    expect(listVideoFilterProviders()).toHaveLength(1);
  });
});
