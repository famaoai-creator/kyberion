import { randomUUID } from 'node:crypto';
import { parseSafeJsonObjectValue } from '@agent/core/foundation';
import { defineScript, isDirectScript } from '../lib/harness.js';

export function parseVoiceHubIngestResponse(payload: unknown): Record<string, unknown> {
  return parseSafeJsonObjectValue(payload, 'voice hub ingest response');
}

async function main() {
  const response = await fetch('http://127.0.0.1:3032/api/ingest-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: randomUUID(),
      text: 'This line came through the managed voice hub.',
      intent: 'conversation',
      speaker: 'User',
      reflect_to_surface: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Voice hub ingest failed: HTTP ${response.status}`);
  }

  const body = parseVoiceHubIngestResponse(await response.json());
  console.log(JSON.stringify(body, null, 2));
}

const runVoiceHubIngestDemo = defineScript({
  name: 'presence-demo-voice-hub-ingest',
  flags: [],
  run: main,
});

if (
  isDirectScript(import.meta.url, 'presence/demo_voice_hub_ingest.ts') ||
  isDirectScript(import.meta.url, 'presence/demo_voice_hub_ingest.js')
)
  void runVoiceHubIngestDemo();
