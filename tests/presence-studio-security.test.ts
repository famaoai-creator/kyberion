import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizePresenceStudioRequest,
  checkPresenceStudioRateLimit,
  isLoopbackOrPrivateAddress,
  presenceStudioEmailDeliverSchema,
  presenceStudioLocationSchema,
  presenceStudioBrowserBootstrapSchema,
  presenceStudioVoiceMinutesSchema,
  presenceStudioVoiceNativeListenSchema,
  presenceStudioVoiceSelectionSchema,
  presenceStudioVoiceStimulusSchema,
  summarizePresenceStudioIdentity,
  summarizePresenceStudioState,
  validateLocalServiceUrl,
} from '../presence/displays/presence-studio/security.js';

const originalToken = process.env.PRESENCE_STUDIO_TOKEN;
const originalApiToken = process.env.KYBERION_API_TOKEN;
const originalAllowRemote = process.env.PRESENCE_STUDIO_ALLOW_REMOTE;

afterEach(() => {
  if (originalToken === undefined) delete process.env.PRESENCE_STUDIO_TOKEN;
  else process.env.PRESENCE_STUDIO_TOKEN = originalToken;

  if (originalApiToken === undefined) delete process.env.KYBERION_API_TOKEN;
  else process.env.KYBERION_API_TOKEN = originalApiToken;

  if (originalAllowRemote === undefined) delete process.env.PRESENCE_STUDIO_ALLOW_REMOTE;
  else process.env.PRESENCE_STUDIO_ALLOW_REMOTE = originalAllowRemote;
});

describe('presence studio security helpers', () => {
  it('allows loopback and private addresses but blocks public hostnames', () => {
    expect(isLoopbackOrPrivateAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackOrPrivateAddress('::1')).toBe(true);
    expect(isLoopbackOrPrivateAddress('10.0.0.5')).toBe(true);
    expect(isLoopbackOrPrivateAddress('example.com')).toBe(false);
  });

  it('validates the voice hub URL as a local service endpoint', () => {
    expect(validateLocalServiceUrl('http://127.0.0.1:3032', 'VOICE_HUB_URL')).toBe(
      'http://127.0.0.1:3032'
    );
    expect(validateLocalServiceUrl('http://10.0.0.5:3032', 'VOICE_HUB_URL')).toBe(
      'http://10.0.0.5:3032'
    );
    expect(() => validateLocalServiceUrl('https://example.com', 'VOICE_HUB_URL')).toThrow(
      'VOICE_HUB_URL must resolve to localhost or a private IP address'
    );
  });

  it('allows local requests without a token', () => {
    const decision = authorizePresenceStudioRequest({
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as any);

    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('local');
  });

  it('requires a token for remote requests unless remote access is explicitly enabled', () => {
    const denied = authorizePresenceStudioRequest({
      headers: {},
      socket: { remoteAddress: '203.0.113.10' },
    } as any);

    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);

    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const rejected = authorizePresenceStudioRequest({
      headers: {},
      socket: { remoteAddress: '203.0.113.10' },
    } as any);
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(401);

    const accepted = authorizePresenceStudioRequest({
      headers: { authorization: 'Bearer studio-token' },
      socket: { remoteAddress: '203.0.113.10' },
    } as any);
    expect(accepted.ok).toBe(true);
    expect(accepted.reason).toBe('token');
  });

  it('rate limits repeated requests from the same client', () => {
    const req = {
      method: 'POST',
      socket: { remoteAddress: '198.51.100.7' },
    } as any;

    expect(checkPresenceStudioRateLimit(req, { limit: 2, windowMs: 1_000 }).ok).toBe(true);
    expect(checkPresenceStudioRateLimit(req, { limit: 2, windowMs: 1_000 }).ok).toBe(true);

    const denied = checkPresenceStudioRateLimit(req, { limit: 2, windowMs: 1_000 });
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(429);
  });

  it('validates high-risk request payloads', () => {
    expect(presenceStudioVoiceStimulusSchema.safeParse({ text: 'hello' }).success).toBe(true);
    expect(presenceStudioVoiceStimulusSchema.safeParse({ text: '' }).success).toBe(false);

    expect(presenceStudioVoiceNativeListenSchema.safeParse({ timeout_seconds: 8 }).success).toBe(
      true
    );
    expect(presenceStudioVoiceNativeListenSchema.safeParse({ timeout_seconds: 60 }).success).toBe(
      false
    );
    expect(
      presenceStudioVoiceSelectionSchema.safeParse({ tts_engine_id: 'local_say' }).success
    ).toBe(true);
    expect(
      presenceStudioVoiceSelectionSchema.safeParse({ stt_backend: 'mlx_whisper' }).success
    ).toBe(true);
    expect(presenceStudioVoiceSelectionSchema.safeParse({}).success).toBe(false);
    expect(
      presenceStudioVoiceSelectionSchema.safeParse({ tts_engine_id: 'x'.repeat(121) }).success
    ).toBe(false);

    expect(
      presenceStudioEmailDeliverSchema.safeParse({ body_markdown: 'hello', approved: true }).success
    ).toBe(true);
    expect(presenceStudioEmailDeliverSchema.safeParse({ approved: true }).success).toBe(false);

    expect(
      presenceStudioVoiceMinutesSchema.safeParse({
        text: 'notes',
        attendees: ['Alice', { name: 'Bob' }],
      }).success
    ).toBe(true);
    expect(
      presenceStudioVoiceMinutesSchema.safeParse({
        text: 'notes',
        attendees: Array.from({ length: 21 }, () => 'x'),
      }).success
    ).toBe(false);

    expect(
      presenceStudioLocationSchema.safeParse({ latitude: 35.6, longitude: 139.7 }).success
    ).toBe(true);
    expect(
      presenceStudioLocationSchema.safeParse({ latitude: 200, longitude: 139.7 }).success
    ).toBe(false);

    expect(
      presenceStudioBrowserBootstrapSchema.safeParse({
        browser_session_id: 'session-1',
        goal_summary: 'Check the page state',
      }).success
    ).toBe(true);
    expect(
      presenceStudioBrowserBootstrapSchema.safeParse({
        browser_session_id: '',
      }).success
    ).toBe(false);

    expect(
      summarizePresenceStudioIdentity({
        sovereign: { name: 'Aoi' },
        agent: { agent_id: 'presence-surface-agent', trust_tier: 'gold' },
        vision: 'hello',
      })
    ).toEqual({
      ok: true,
      onboarded: true,
      sovereign: { name: 'Aoi' },
      agent: { agent_id: 'presence-surface-agent', trust_tier: 'gold' },
      vision: 'hello',
    });

    expect(
      summarizePresenceStudioState({
        surfaces: { a: {}, b: {}, c: {} },
        recentStimuli: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        lastUpdatedAt: '2026-05-22T00:00:00.000Z',
      })
    ).toEqual({
      ok: true,
      surfaces_count: 3,
      recentStimuli: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      lastUpdatedAt: '2026-05-22T00:00:00.000Z',
    });
  });
});
