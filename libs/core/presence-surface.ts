import { randomUUID } from 'node:crypto';
import type { A2UIMessage } from './a2ui.js';

export interface PresenceVoiceStimulus {
  id: string;
  request_id: string;
  ts: string;
  ttl: number;
  origin: {
    channel: 'voice';
    source_id: string;
  };
  signal: {
    intent: string;
    priority: number;
    payload: string;
  };
  control: {
    status: 'pending';
    feedback: 'auto';
    evidence: Array<{ step: string; ts: string; agent: string }>;
  };
}

export interface PresenceSurfaceFrameInput {
  surfaceId?: string;
  title?: string;
  status?: string;
  expression?: string;
  subtitle?: string;
  transcript?: Array<{ speaker: string; text: string }>;
}

export type PresenceTimelineOp =
  | 'set_status'
  | 'set_expression'
  | 'set_subtitle'
  | 'clear_subtitle'
  | 'append_transcript'
  | 'clear_transcript';

export interface PresenceTimelineEvent {
  at_ms: number;
  op: PresenceTimelineOp;
  params?: Record<string, unknown>;
}

export interface PresenceTimelineAdf {
  action: 'presence_timeline';
  surface_id?: string;
  title?: string;
  interrupt_policy?: 'replace' | 'ignore';
  events: PresenceTimelineEvent[];
}

export interface PresenceVoiceIngressOptions {
  surfaceId?: string;
  speaker?: string;
  text: string;
  listening_ms?: number;
}

export interface PresenceAssistantReplyOptions {
  surfaceId?: string;
  speaker?: string;
  text: string;
  thinking_ms?: number;
  speaking_ms?: number;
}

export function createPresenceVoiceStimulus(
  text: string,
  intent = 'conversation',
  sourceId = 'local-mic',
  requestId: string = randomUUID(),
): PresenceVoiceStimulus {
  const ts = new Date().toISOString();
  return {
    id: `voice-${randomUUID()}`,
    request_id: requestId,
    ts,
    ttl: 3600,
    origin: {
      channel: 'voice',
      source_id: sourceId,
    },
    signal: {
      intent,
      priority: 8,
      payload: text,
    },
    control: {
      status: 'pending',
      feedback: 'auto',
      evidence: [
        {
          step: 'voice_capture',
          ts,
          agent: 'voice-hub',
        },
      ],
    },
  };
}

export function buildPresenceSurfaceFrame(input: PresenceSurfaceFrameInput): A2UIMessage[] {
  const surfaceId = input.surfaceId || 'presence-studio';
  const transcript = input.transcript || [];
  return [
    {
      createSurface: {
        surfaceId,
        catalogId: 'expressive-surface',
        title: input.title || 'Presence Studio',
      },
    },
    {
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'presence-status',
            type: 'presence.status',
            props: {
              label: input.status || 'idle',
              expression: input.expression || 'neutral',
            },
          },
          {
            id: 'presence-subtitle',
            type: 'presence.subtitle',
            props: {
              text: input.subtitle || '',
            },
          },
          {
            id: 'presence-transcript',
            type: 'presence.transcript',
            props: {
              items: transcript,
            },
          },
        ],
      },
    },
    {
      updateDataModel: {
        surfaceId,
        data: {
          title: input.title || 'Presence Studio',
          status: input.status || 'idle',
          expression: input.expression || 'neutral',
          subtitle: input.subtitle || '',
          transcript,
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];
}

export function validatePresenceTimeline(input: unknown): PresenceTimelineAdf {
  if (!input || typeof input !== 'object') {
    throw new Error('Presence timeline must be an object.');
  }
  const timeline = input as PresenceTimelineAdf;
  if (timeline.action !== 'presence_timeline') {
    throw new Error('Presence timeline action must be "presence_timeline".');
  }
  if (!Array.isArray(timeline.events) || timeline.events.length === 0) {
    throw new Error('Presence timeline requires at least one event.');
  }

  for (const event of timeline.events) {
    if (!event || typeof event !== 'object') {
      throw new Error('Presence timeline event must be an object.');
    }
    if (typeof event.at_ms !== 'number' || event.at_ms < 0) {
      throw new Error('Presence timeline event requires a non-negative at_ms.');
    }
    if (![
      'set_status',
      'set_expression',
      'set_subtitle',
      'clear_subtitle',
      'append_transcript',
      'clear_transcript',
    ].includes(event.op)) {
      throw new Error(`Unsupported presence timeline op: ${String(event.op)}`);
    }
  }

  return {
    ...timeline,
    interrupt_policy: timeline.interrupt_policy || 'replace',
    surface_id: timeline.surface_id || 'presence-studio',
  };
}

export function buildPresenceVoiceIngressTimeline(input: PresenceVoiceIngressOptions): PresenceTimelineAdf {
  const listeningMs = typeof input.listening_ms === 'number' && input.listening_ms >= 0 ? input.listening_ms : 1400;
  const speaker = input.speaker || 'User';
  return {
    action: 'presence_timeline',
    surface_id: input.surfaceId || 'presence-studio',
    interrupt_policy: 'replace',
    events: [
      { at_ms: 0, op: 'set_status', params: { value: 'listening' } },
      { at_ms: 0, op: 'set_expression', params: { value: 'neutral' } },
      { at_ms: 0, op: 'set_subtitle', params: { text: `Heard: ${input.text}` } },
      { at_ms: 0, op: 'append_transcript', params: { speaker, text: input.text } },
      { at_ms: listeningMs, op: 'clear_subtitle' },
      { at_ms: listeningMs, op: 'set_status', params: { value: 'ready' } },
    ],
  };
}

export function buildPresenceAssistantReplyTimeline(input: PresenceAssistantReplyOptions): PresenceTimelineAdf {
  const thinkingMs = typeof input.thinking_ms === 'number' && input.thinking_ms >= 0 ? input.thinking_ms : 700;
  const speakingMs = typeof input.speaking_ms === 'number' && input.speaking_ms >= 0 ? input.speaking_ms : 1700;
  const speaker = input.speaker || 'Kyberion';
  return {
    action: 'presence_timeline',
    surface_id: input.surfaceId || 'presence-studio',
    interrupt_policy: 'replace',
    events: [
      { at_ms: 0, op: 'set_status', params: { value: 'thinking' } },
      { at_ms: 0, op: 'set_expression', params: { value: 'neutral' } },
      { at_ms: 0, op: 'set_subtitle', params: { text: 'Thinking...' } },
      { at_ms: thinkingMs, op: 'set_status', params: { value: 'speaking' } },
      { at_ms: thinkingMs, op: 'set_expression', params: { value: 'joy' } },
      { at_ms: thinkingMs, op: 'set_subtitle', params: { text: input.text } },
      { at_ms: thinkingMs, op: 'append_transcript', params: { speaker, text: input.text } },
      { at_ms: thinkingMs + speakingMs, op: 'clear_subtitle' },
      { at_ms: thinkingMs + speakingMs, op: 'set_status', params: { value: 'ready' } },
    ],
  };
}

export function estimateSpeechDurationMs(text: string, wordsPerMinute = 180): number {
  const trimmed = text.trim();
  if (!trimmed) return 800;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const base = Math.ceil((words / Math.max(120, wordsPerMinute)) * 60_000);
  const punctuationPause = (trimmed.match(/[.,!?。！？、]/g) || []).length * 120;
  return Math.max(1200, base + punctuationPause);
}
