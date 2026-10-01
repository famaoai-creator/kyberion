import { describe, expect, it } from 'vitest';
import {
  applyChannelMarkupEscapes,
  getChannelAdapter,
  listChannelAdapters,
  listHumanChatChannels,
  listOperatorNotificationChannels,
  listPresenceDispatchChannels,
  neutralizeChannelMarkup,
  resolveChannelMessageShape,
  resolveChannelMissionEventStream,
} from './channel-adapter-registry.js';
import { listSurfaceProviderManifestRecords } from './surface-provider-policy.js';

describe('channel adapter registry (RS-06)', () => {
  it('derives channel lists from registry data', () => {
    expect(listOperatorNotificationChannels().sort()).toEqual(
      ['discord', 'imessage', 'inbox', 'slack', 'telegram'].sort()
    );
    expect(listHumanChatChannels().sort()).toEqual(
      ['discord', 'imessage', 'slack', 'telegram'].sort()
    );
    expect(listPresenceDispatchChannels()).toEqual(
      expect.arrayContaining([
        { id: 'slack', via: 'slack-webclient' },
        { id: 'telegram', via: 'satellite-outbox' },
        { id: 'discord', via: 'satellite-outbox' },
        { id: 'imessage', via: 'satellite-outbox' },
      ])
    );
  });

  it('binds every non-local channel to a registered surface provider', () => {
    const providerIds = new Set(listSurfaceProviderManifestRecords().map((record) => record.id));
    for (const adapter of listChannelAdapters()) {
      if (adapter.local) continue;
      expect(providerIds.has((adapter.surface_provider ?? adapter.id) as never)).toBe(true);
    }
  });

  it('fails closed for an unknown channel', () => {
    expect(() => getChannelAdapter('carrier-pigeon')).toThrow(/unknown channel "carrier-pigeon"/);
    expect(() => neutralizeChannelMarkup('x', 'carrier-pigeon')).toThrow(/unknown channel/);
  });

  it('applies data-declared escaping rules', () => {
    expect(
      applyChannelMarkupEscapes('a-b]c @Here', {
        dialect: 'discord-markdown',
        backslash_escape_chars: '-]',
        mention_guards: ['here'],
      })
    ).toBe('a\\-b\\]c @​Here');
    expect(
      applyChannelMarkupEscapes('<&>', {
        dialect: 'slack-mrkdwn',
        entity_escapes: { '&': '&amp;', '<': '&lt;', '>': '&gt;' },
      })
    ).toBe('&lt;&amp;&gt;');
  });

  it('resolves message shape and mission-event stream with generic/shared defaults', () => {
    expect(resolveChannelMessageShape('slack')).toBe('slack-thread');
    expect(resolveChannelMessageShape('chronos')).toBe('chronos-session');
    expect(resolveChannelMessageShape('terminal')).toBe('generic');
    expect(resolveChannelMissionEventStream('slack')).toBe('slack');
    expect(resolveChannelMissionEventStream('chronos')).toBe('chronos');
    expect(resolveChannelMissionEventStream('telegram')).toBe('shared');
    expect(resolveChannelMissionEventStream('cli')).toBe('shared');
  });
});
