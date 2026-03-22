import { afterEach, describe, expect, it } from 'vitest';
import { resolveServiceBinding } from './service-binding.js';

describe('service-binding', () => {
  const originalMissionId = process.env.MISSION_ID;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const originalSlackAppToken = process.env.SLACK_APP_TOKEN;
  const originalCanvaAccessToken = process.env.CANVA_ACCESS_TOKEN;
  const originalCanvaRefreshToken = process.env.CANVA_REFRESH_TOKEN;
  const originalCanvaClientId = process.env.CANVA_CLIENT_ID;
  const originalCanvaClientSecret = process.env.CANVA_CLIENT_SECRET;

  afterEach(() => {
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;

    if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;

    if (originalSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = originalSlackAppToken;

    if (originalCanvaAccessToken === undefined) delete process.env.CANVA_ACCESS_TOKEN;
    else process.env.CANVA_ACCESS_TOKEN = originalCanvaAccessToken;

    if (originalCanvaRefreshToken === undefined) delete process.env.CANVA_REFRESH_TOKEN;
    else process.env.CANVA_REFRESH_TOKEN = originalCanvaRefreshToken;

    if (originalCanvaClientId === undefined) delete process.env.CANVA_CLIENT_ID;
    else process.env.CANVA_CLIENT_ID = originalCanvaClientId;

    if (originalCanvaClientSecret === undefined) delete process.env.CANVA_CLIENT_SECRET;
    else process.env.CANVA_CLIENT_SECRET = originalCanvaClientSecret;
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

  it('resolves oauth-style service credentials for secret-guard mode', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    process.env.CANVA_ACCESS_TOKEN = 'canva-access-token';
    process.env.CANVA_REFRESH_TOKEN = 'canva-refresh-token';
    process.env.CANVA_CLIENT_ID = 'client-id';
    process.env.CANVA_CLIENT_SECRET = 'cnvca-test-secret';

    const binding = resolveServiceBinding('canva', 'secret-guard');
    expect(binding).toMatchObject({
      serviceId: 'canva',
      authMode: 'secret-guard',
      accessToken: 'canva-access-token',
      refreshToken: 'canva-refresh-token',
      clientId: 'client-id',
      clientSecret: 'cnvca-test-secret',
    });
    expect(binding.metadata).toMatchObject({
      hasAccessToken: true,
      hasRefreshToken: true,
      hasClientId: true,
      hasClientSecret: true,
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
