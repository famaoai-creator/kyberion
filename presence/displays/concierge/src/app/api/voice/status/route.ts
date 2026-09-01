import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@agent/core/foundation';
import { voiceHubUrl } from '../../../../lib/voice-hub';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import type { VoiceStatusResponse } from '../../../../lib/voice-types';
import {
  parseVoiceInputDevices,
  parseVoiceSpeechState,
  parseVoiceStatusResponse,
} from '../../../../lib/voice-types';

export const dynamic = 'force-dynamic';

/**
 * CS-02 tier probe — read-only aggregation of the voice-hub capability
 * endpoints. The dock calls this on mount (and on demand) to decide
 * between Tier 0 (browser Web Speech) and Tier 1 (voice-hub native STT +
 * server TTS). It NEVER throws to the client: any failure — daemon down,
 * slow answer, malformed JSON — degrades to `available: false` so the UI
 * silently falls back to Tier 0.
 */
const PROBE_TIMEOUT_MS = 1500;

async function probeJson(path: string): Promise<unknown | null> {
  try {
    const response = await fetch(`${voiceHubUrl()}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // voice-hub down/slow — treated as "capability absent", never as an error.
    return null;
  }
}

/** voice-hub availability keys → VoiceSttBackend ids (libs/core/voice-stt.ts). */
const BACKEND_IDS: Array<[string, string]> = [
  ['server', 'server'],
  ['fluidAudio', 'fluid_audio'],
  ['fasterWhisper', 'faster_whisper'],
  ['mlxWhisper', 'mlx_whisper'],
  ['whisperCpp', 'whisper_cpp'],
  ['nativeSpeech', 'native_speech'],
];

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  const health = await probeJson('/health');
  if (!isRecord(health) || health.ok !== true) {
    return NextResponse.json({ available: false } satisfies VoiceStatusResponse);
  }

  const [backends, devices, speech] = await Promise.all([
    probeJson('/api/stt/backends'),
    probeJson('/api/input-devices'),
    probeJson('/api/speech/state'),
  ]);

  const backendRecord = isRecord(backends) ? backends : undefined;
  const availableBackends =
    backendRecord && isRecord(backendRecord.available) ? backendRecord.available : undefined;
  const sttBackends =
    backendRecord?.ok === true && availableBackends
      ? BACKEND_IDS.filter(([key]) => availableBackends[key] === true).map(([, id]) => id)
      : undefined;
  const backendSelection =
    backendRecord && isRecord(backendRecord.selection) ? backendRecord.selection : undefined;
  const persistedBackend =
    backendRecord?.ok === true && typeof backendSelection?.selected_backend === 'string'
      ? backendSelection.selected_backend
      : undefined;
  const deviceRecord = isRecord(devices) ? devices : undefined;
  const inputDevices =
    deviceRecord?.ok === true ? parseVoiceInputDevices(deviceRecord.devices) : undefined;
  const speechRecord = isRecord(speech) ? speech : undefined;
  const speechState =
    speechRecord?.ok === true ? parseVoiceSpeechState(speechRecord.speech) : undefined;

  const payload = parseVoiceStatusResponse({
    available: true,
    sttBackends,
    selectedSttBackend:
      persistedBackend && persistedBackend !== 'auto' && sttBackends?.includes(persistedBackend)
        ? persistedBackend
        : undefined,
    inputDevices,
    speech: speechState,
  });
  if (!payload) {
    return NextResponse.json({ available: false } satisfies VoiceStatusResponse, { status: 502 });
  }
  return NextResponse.json(payload);
}
