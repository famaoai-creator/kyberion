import { describe, expect, it } from 'vitest';
import {
  parseConfigMissionsResponse,
  parseNotificationPreferencesResponse,
  parsePluginListResponse,
} from './setup-auxiliary-response';

describe('concierge setup auxiliary response boundaries', () => {
  it('accepts notification and plugin projections', () => {
    expect(
      parseNotificationPreferencesResponse({
        ok: true,
        preferences: { default_channel: { surface: 'slack', target: '#ops' } },
        channels: [{ surface: 'slack', display_name: 'Slack', status: 'ready' }],
      })
    ).toBeDefined();
    expect(
      parsePluginListResponse({
        ok: true,
        plugins: [
          {
            id: 'plugin-1',
            trust: 'official',
            status: 'activatable',
            source: 'configured',
          },
        ],
      })
    ).toHaveLength(1);
  });

  it('accepts config mission presets and recent records', () => {
    expect(
      parseConfigMissionsResponse({
        ok: true,
        tenants: ['default'],
        presets: [
          {
            id: 'preset-1',
            category: 'service',
            description: 'Configure a service',
            inputs: [{ key: 'endpoint', type: 'string', description: 'Endpoint', required: true }],
            write_target_count: 1,
          },
        ],
        recent: [
          {
            id: 'cfg-1',
            preset: 'preset-1',
            tenant: 'default',
            status: 'draft',
            created_at: '2026-09-04T00:00:00Z',
          },
        ],
      })
    ).toBeDefined();
  });

  it('rejects malformed and unsafe nested values', () => {
    expect(
      parseNotificationPreferencesResponse({
        ok: true,
        preferences: { default_channel: { surface: 'slack' } },
        channels: [],
      })
    ).toBeUndefined();
    expect(
      parsePluginListResponse({
        ok: true,
        plugins: [{ id: 'plugin-1', trust: 'official', status: 'unknown', source: 'configured' }],
      })
    ).toBeUndefined();
    const unsafe = JSON.parse('{"ok":true,"tenants":[],"presets":[],"recent":[],"constructor":{}}');
    expect(parseConfigMissionsResponse(unsafe)).toBeUndefined();
  });
});
