import { describe, expect, it } from 'vitest';
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceSurfaceFrame,
  buildPresenceVoiceIngressTimeline,
  createPresenceVoiceStimulus,
  estimateSpeechDurationMs,
  validatePresenceTimeline,
} from './presence-surface.js';
import { getPresenceAvatarProfile } from './presence-avatar.js';

describe('presence-surface helpers', () => {
  it('creates governed voice stimuli with expected defaults', () => {
    const stimulus = createPresenceVoiceStimulus('hello world', 'conversation', 'local-mic', 'req-123');

    expect(stimulus.origin.channel).toBe('voice');
    expect(stimulus.request_id).toBe('req-123');
    expect(stimulus.signal.payload).toBe('hello world');
    expect(stimulus.signal.intent).toBe('conversation');
    expect(stimulus.control.status).toBe('pending');
  });

  it('builds an expressive surface frame as A2UI messages', () => {
    const messages = buildPresenceSurfaceFrame({
      agentId: 'chronos-agent',
      subtitle: 'hello',
      expression: 'joy',
      transcript: [{ speaker: 'AI', text: 'hello' }],
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].createSurface?.surfaceId).toBe('presence-studio');
    expect(messages[1].updateComponents?.components).toHaveLength(4);
    expect(messages[2].updateDataModel?.data.expression).toBe('joy');
    expect(messages[2].updateDataModel?.data.agentId).toBe('chronos-agent');
    expect(messages[2].updateDataModel?.data.avatarAssetPath).toBe('/assets/avatars/chronos-neutral.svg');
  });

  it('validates presence timelines and applies defaults', () => {
    const timeline = validatePresenceTimeline({
      action: 'presence_timeline',
      events: [
        { at_ms: 0, op: 'set_expression', params: { value: 'joy' } },
      ],
    });

    expect(timeline.surface_id).toBe('presence-studio');
    expect(timeline.interrupt_policy).toBe('replace');
  });

  it('builds a voice ingress timeline for the expressive surface', () => {
    const timeline = buildPresenceVoiceIngressTimeline({
      agentId: 'presence-surface-agent',
      text: 'hello from voice',
      speaker: 'User',
    });

    expect(timeline.events[0]).toEqual({ at_ms: 0, op: 'set_agent', params: { agentId: 'presence-surface-agent' } });
    expect(timeline.events[1]).toEqual({ at_ms: 0, op: 'set_status', params: { value: 'listening' } });
    expect(timeline.events[4]).toEqual({ at_ms: 0, op: 'append_transcript', params: { speaker: 'User', text: 'hello from voice' } });
  });

  it('builds an assistant reply timeline with thinking and speaking phases', () => {
    const timeline = buildPresenceAssistantReplyTimeline({
      agentId: 'slack-surface-agent',
      text: 'hello back',
    });

    expect(timeline.events[0]).toEqual({ at_ms: 0, op: 'set_agent', params: { agentId: 'slack-surface-agent' } });
    expect(timeline.events[1]).toEqual({ at_ms: 0, op: 'set_status', params: { value: 'thinking' } });
    expect(timeline.events[4]).toEqual({ at_ms: 700, op: 'set_status', params: { value: 'speaking' } });
    expect(timeline.events[7]).toEqual({ at_ms: 700, op: 'append_transcript', params: { speaker: 'Kyberion', text: 'hello back' } });
  });

  it('resolves an avatar profile per agent id', () => {
    expect(getPresenceAvatarProfile('presence-surface-agent').displayName).toBe('Kyberion');
    expect(getPresenceAvatarProfile('chronos-mirror').displayName).toBe('Chronos');
    expect(getPresenceAvatarProfile('chronos-mirror').defaultAvatarAssetPath).toBe('/assets/avatars/chronos-neutral.svg');
    expect(getPresenceAvatarProfile('unknown-agent').agentId).toBe('unknown-agent');
  });

  it('estimates speech duration with a sensible floor', () => {
    expect(estimateSpeechDurationMs('hello')).toBeGreaterThanOrEqual(1200);
    expect(estimateSpeechDurationMs('this is a much longer utterance with several words')).toBeGreaterThanOrEqual(1200);
  });
});
