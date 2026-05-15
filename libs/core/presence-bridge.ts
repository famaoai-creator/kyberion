import type { A2UIMessage } from './a2ui.js';
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceSurfaceFrame,
  type PresenceSurfaceFrameInput,
} from './presence-surface.js';
import { redactSensitiveObject } from './network.js';

const PRESENCE_STUDIO_URL = process.env.PRESENCE_STUDIO_URL || 'http://127.0.0.1:3031';

export async function dispatchPresenceMessages(messages: A2UIMessage[], baseUrl = PRESENCE_STUDIO_URL): Promise<void> {
  const response = await fetch(`${baseUrl}/a2ui/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redactSensitiveObject(messages)),
  });
  if (!response.ok) {
    throw new Error(`presence_dispatch_http_${response.status}`);
  }
}

export async function dispatchPresenceFrame(input: PresenceSurfaceFrameInput, baseUrl = PRESENCE_STUDIO_URL): Promise<void> {
  await dispatchPresenceMessages(buildPresenceSurfaceFrame(input), baseUrl);
}

export async function reflectPresenceAgentReply(input: {
  agentId: string;
  text: string;
  speaker?: string;
  surfaceId?: string;
  thinkingMs?: number;
  speakingMs?: number;
}, baseUrl = PRESENCE_STUDIO_URL): Promise<void> {
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
