import { describe, expect, it } from 'vitest';
import { parseServiceManifest } from './service-actuator-helpers.js';

describe('parseServiceManifest', () => {
  it('normalizes service entries and keeps string-only environment values', () => {
    expect(
      parseServiceManifest({
        slack: {
          path: 'satellites/slack-bridge/dist/index.js',
          description: 'Slack bridge',
          preset_path: 'knowledge/product/orchestration/service-presets/slack.json',
          env: { NODE_ENV: 'production' },
          ignored: { nested: true },
        },
      })
    ).toEqual({
      slack: {
        path: 'satellites/slack-bridge/dist/index.js',
        description: 'Slack bridge',
        preset_path: 'knowledge/product/orchestration/service-presets/slack.json',
        env: { NODE_ENV: 'production' },
      },
    });
  });

  it('fails closed for malformed entries and dangerous environment keys', () => {
    expect(parseServiceManifest(null)).toBeNull();
    expect(parseServiceManifest({ slack: { path: '' } })).toBeNull();
    expect(parseServiceManifest({ slack: { path: 'bridge.js', env: { PORT: 3317 } } })).toBeNull();
    expect(
      parseServiceManifest(
        JSON.parse('{"slack":{"path":"bridge.js","env":{"__proto__":"polluted"}}}')
      )
    ).toBeNull();
  });
});
