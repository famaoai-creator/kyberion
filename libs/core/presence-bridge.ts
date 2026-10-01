import type { A2UIMessage } from './a2ui.js';
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceSurfaceFrame,
  type PresenceSurfaceFrameInput,
} from './presence-surface.js';
import { resolveSurfaceUrl } from './surface/surface-url.js';
import { redactSensitiveObject } from './network.js';

export async function dispatchPresenceMessages(
  messages: A2UIMessage[],
  baseUrl = resolveSurfaceUrl('presence-studio')
): Promise<void> {
  const response = await fetch(`${baseUrl}/a2ui/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redactSensitiveObject(messages)),
  });
  if (!response.ok) {
    throw new Error(`presence_dispatch_http_${response.status}`);
  }
}

export async function dispatchPresenceFrame(
  input: PresenceSurfaceFrameInput,
  baseUrl = resolveSurfaceUrl('presence-studio')
): Promise<void> {
  await dispatchPresenceMessages(buildPresenceSurfaceFrame(input), baseUrl);
}

export async function reflectPresenceAgentReply(
  input: {
    agentId: string;
    text: string;
    speaker?: string;
    surfaceId?: string;
    thinkingMs?: number;
    speakingMs?: number;
  },
  baseUrl = resolveSurfaceUrl('presence-studio')
): Promise<void> {
  const timeline = buildPresenceAssistantReplyTimeline({
    agentId: input.agentId,
    surfaceId: input.surfaceId,
    text: input.text,
    speaker: input.speaker,
    thinking_ms: input.thinkingMs,
    speaking_ms: input.speakingMs,
  });
  const response = await fetch(`${baseUrl}/api/timeline/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redactSensitiveObject(timeline)),
  });
  if (!response.ok) {
    throw new Error(`presence_timeline_http_${response.status}`);
  }
}
