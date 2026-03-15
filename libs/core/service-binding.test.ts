import { afterEach, describe, expect, it } from 'vitest';
import { resolveServiceBinding } from './service-binding.js';

describe('service-binding', () => {
  const originalMissionId = process.env.MISSION_ID;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const originalSlackAppToken = process.env.SLACK_APP_TOKEN;

  afterEach(() => {
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;

    if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;

    if (originalSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = originalSlackAppToken;
  });

  it('returns a plain binding for none auth mode', () => {
    expect(resolveServiceBinding('slack')).toEqual({
      serviceId: 'slack',
      authMode: 'none',
    });
  });

  it('returns a session note for session auth mode', () => {
    const binding = resolveServiceBinding('chronos', 'session');
    expect(binding.authMode).toBe('session');
    expect(binding.metadata?.note).toContain('Session-based bindings');
  });

  it('resolves service tokens from environment for secret-guard mode', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';

    const binding = resolveServiceBinding('slack', 'secret-guard');
    expect(binding).toMatchObject({
      serviceId: 'slack',
      authMode: 'secret-guard',
      accessToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
    });
    expect(binding.metadata).toMatchObject({
      serviceScoped: true,
      hasAccessToken: true,
      hasAppToken: true,
    });
  });

  it('throws when secret-guard binding has no secrets', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;

    expect(() => resolveServiceBinding('slack', 'secret-guard')).toThrow(
      'Access denied: no service binding secret found for "slack"',
    );
  });
});
