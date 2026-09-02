import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PresenceStudioViewerError,
  parsePresenceStudioAgentIdentity,
  parsePresenceStudioSovereignIdentity,
  presenceStudioDemoFrameSchema,
  presenceStudioMinutesSessionStartSchema,
  presenceStudioVoiceStopSchema,
  requirePresenceStudioLocalAdmin,
  resolvePresenceStudioViewerContext,
} from './security.js';

function request(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as never;
}

describe('Presence Studio OS viewer scope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats loopback as a server-derived local human scope', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');

    expect(resolvePresenceStudioViewerContext(request('127.0.0.1'))).toEqual({
      principalId: 'human:presence-studio-localadmin',
      tenantSlugs: ['tenant-local'],
      source: 'loopback',
    });
  });

  it('requires a bearer token and server tenant scope for remote access', () => {
    vi.stubEnv('PRESENCE_STUDIO_ALLOW_REMOTE', 'true');
    vi.stubEnv('PRESENCE_STUDIO_TOKEN', 'presence-token');

    expect(() => resolvePresenceStudioViewerContext(request('198.51.100.24'))).toThrow(
      PresenceStudioViewerError
    );
    expect(() =>
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toThrow(/server-side KYBERION_TENANT/);

    vi.stubEnv('KYBERION_TENANT', 'tenant-remote');
    expect(
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toEqual({
      principalId: 'human:presence-studio-token',
      tenantSlugs: ['tenant-remote'],
      source: 'token',
    });
  });

  it('denies held-action mutations for readonly token viewers', () => {
    expect(() =>
      requirePresenceStudioLocalAdmin({
        principalId: 'human:presence-studio-token',
        tenantSlugs: ['tenant-remote'],
        source: 'token',
      })
    ).toThrow(/localadmin/);
    expect(() =>
      requirePresenceStudioLocalAdmin({
        principalId: 'human:presence-studio-localadmin',
        tenantSlugs: ['tenant-local'],
        source: 'loopback',
      })
    ).not.toThrow();
  });

  it('rejects ambiguous minutes and voice-stop request bodies before side effects', () => {
    expect(
      presenceStudioMinutesSessionStartSchema.safeParse({
        missionId: ['MSN-1'],
      }).success
    ).toBe(false);
    expect(
      presenceStudioMinutesSessionStartSchema.safeParse({
        missionId: 'MSN-1',
        unexpected: true,
      }).success
    ).toBe(false);
    expect(
      presenceStudioMinutesSessionStartSchema.parse({
        missionId: ' MSN-1 ',
        title: ' Weekly sync ',
      })
    ).toEqual({ missionId: 'MSN-1', title: 'Weekly sync' });

    expect(presenceStudioVoiceStopSchema.safeParse({ reason: { value: 'stop' } }).success).toBe(
      false
    );
    expect(presenceStudioVoiceStopSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(presenceStudioVoiceStopSchema.parse({ reason: ' manual ' })).toEqual({
      reason: 'manual',
    });
    expect(presenceStudioVoiceStopSchema.parse(undefined)).toEqual({});

    expect(
      presenceStudioDemoFrameSchema.safeParse({
        transcript: [{ speaker: 'AI', text: 'ok', extra: true }],
      }).success
    ).toBe(false);
    expect(presenceStudioDemoFrameSchema.safeParse({ expression: ['joy'] }).success).toBe(false);
    expect(
      presenceStudioDemoFrameSchema.parse({
        title: ' Demo ',
        transcript: [{ speaker: ' AI ', text: ' Hello ' }],
      })
    ).toEqual({ title: 'Demo', transcript: [{ speaker: 'AI', text: 'Hello' }] });
    expect(presenceStudioDemoFrameSchema.parse(undefined)).toEqual({});
  });

  it('parses identity files through a display-only field contract', () => {
    expect(parsePresenceStudioSovereignIdentity({ name: ' Operator ', extra: true })).toEqual({
      name: 'Operator',
    });
    expect(parsePresenceStudioAgentIdentity({ agent_id: 'agent-1', trust_tier: 'T2' })).toEqual({
      agent_id: 'agent-1',
      trust_tier: 'T2',
    });
    expect(parsePresenceStudioSovereignIdentity({ name: 42 })).toBeNull();
    expect(parsePresenceStudioAgentIdentity({ agent_id: ['agent-1'] })).toBeNull();
    expect(parsePresenceStudioSovereignIdentity(['Operator'])).toBeNull();
  });
});
