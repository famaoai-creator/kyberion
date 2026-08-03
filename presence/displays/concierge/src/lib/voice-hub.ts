/**
 * Server-side voice-hub endpoint resolution shared by the /api/voice/*
 * proxy routes. The browser cannot reach the voice-hub daemon
 * (127.0.0.1:3032) cross-origin, so every voice call goes through these
 * Next routes. Same env contract as the voice-hub itself
 * (satellites/voice-hub/server.ts: VOICE_HUB_PORT) and the /api/message
 * route (VOICE_HUB_URL).
 */
export function voiceHubUrl(): string {
  return process.env.VOICE_HUB_URL || `http://127.0.0.1:${process.env.VOICE_HUB_PORT || '3032'}`;
}
