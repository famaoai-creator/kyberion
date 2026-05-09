import { describe, expect, it } from 'vitest';

import {
  getSurfaceProviderManifest,
  listSurfaceProviderManifests,
} from './surface-provider-manifest.js';

describe('surface-provider-manifest', () => {
  it('lists manifests for all supported human-facing surfaces', () => {
    const ids = listSurfaceProviderManifests().map((entry) => entry.id).sort();
    expect(ids).toEqual(['chronos', 'discord', 'imessage', 'presence', 'slack', 'telegram']);
  });

  it('keeps provider capabilities explicit', () => {
    const slack = getSurfaceProviderManifest('slack');
    const presence = getSurfaceProviderManifest('presence');
    const imessage = getSurfaceProviderManifest('imessage');
    const discord = getSurfaceProviderManifest('discord');
    const telegram = getSurfaceProviderManifest('telegram');

    expect(slack.capabilities.reply).toBe(true);
    expect(slack.delivery.directReply).toBe('outbox');
    expect(presence.capabilities.reply).toBe(false);
    expect(presence.delivery.directReply).toBe('notification');
    expect(imessage.capabilities.reply).toBe(true);
    expect(imessage.delivery.directReply).toBe('notification');
    expect(discord.capabilities.reply).toBe(true);
    expect(discord.delivery.directReply).toBe('outbox');
    expect(telegram.capabilities.reply).toBe(true);
    expect(telegram.delivery.directReply).toBe('outbox');
  });
});
