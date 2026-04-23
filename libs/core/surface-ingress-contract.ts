import { randomUUID } from 'node:crypto';

import type { SlackSurfaceInput, SurfaceAsyncChannel } from './channel-surface-types.js';

export interface SurfaceIngressEnvelope {
  messageId: string;
  surface: SurfaceAsyncChannel;
  channel: string;
  threadTs: string;
  correlationId: string;
  text: string;
  receivedAt: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

export function buildSlackSurfaceIngressEnvelope(input: SlackSurfaceInput & { correlationId?: string; messageId?: string }): SurfaceIngressEnvelope {
  return {
    messageId: input.messageId || input.ts || `SLACK-MSG-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: 'slack',
    channel: input.channel,
    threadTs: input.threadTs || input.ts || 'unknown',
    correlationId: input.correlationId || randomUUID(),
    text: input.text,
    receivedAt: input.ts || new Date().toISOString(),
    actorId: 'slack-surface-agent',
    metadata: {
      user: input.user,
      team: input.team,
      channelType: input.channelType,
    },
  };
}

export function buildChronosSurfaceIngressEnvelope(input: {
  text: string;
  sessionId?: string;
  requesterId?: string;
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
}): SurfaceIngressEnvelope {
  return {
    messageId: input.messageId || `CHRONOS-MSG-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: 'chronos',
    channel: 'chronos',
    threadTs: input.sessionId || 'chronos-default',
    correlationId: input.correlationId || randomUUID(),
    text: input.text,
    receivedAt: input.receivedAt || new Date().toISOString(),
    actorId: input.requesterId || 'chronos-ui',
  };
}

export function buildPresenceSurfaceIngressEnvelope(input: {
  text: string;
  channel?: string;
  threadTs?: string;
  speakerId?: string;
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
}): SurfaceIngressEnvelope {
  return {
    messageId: input.messageId || `PRESENCE-MSG-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: 'presence',
    channel: input.channel || 'presence',
    threadTs: input.threadTs || 'presence-default',
    correlationId: input.correlationId || randomUUID(),
    text: input.text,
    receivedAt: input.receivedAt || new Date().toISOString(),
    actorId: input.speakerId || 'presence-user',
  };
}
