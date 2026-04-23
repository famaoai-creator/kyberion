import { describe, expect, it } from 'vitest';

import {
  getSurfaceProviderManifest,
  listSurfaceProviderManifests,
} from './surface-provider-manifest.js';

describe('surface-provider-manifest', () => {
  it('lists manifests for all supported human-facing surfaces', () => {
    const ids = listSurfaceProviderManifests().map((entry) => entry.id).sort();
    expect(ids).toEqual(['chronos', 'presence', 'slack']);
  });

  it('keeps provider capabilities explicit', () => {
    const slack = getSurfaceProviderManifest('slack');
    const presence = getSurfaceProviderManifest('presence');

    expect(slack.capabilities.reply).toBe(true);
    expect(slack.delivery.directReply).toBe('outbox');
    expect(presence.capabilities.reply).toBe(false);
    expect(presence.delivery.directReply).toBe('notification');
  });
});
