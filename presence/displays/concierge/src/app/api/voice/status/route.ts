import { NextResponse } from 'next/server';
import { voiceHubUrl } from '../../../../lib/voice-hub';
import type {
  VoiceInputDevice,
  VoiceSpeechState,
  VoiceStatusResponse,
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

async function probeJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${voiceHubUrl()}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // voice-hub down/slow — treated as "capability absent", never as an error.
    return null;
  }
}

/** voice-hub availability keys → VoiceSttBackend ids (libs/core/voice-stt.ts). */
const BACKEND_IDS: Array<[string, string]> = [
  ['server', 'server'],
  ['fluidAudio', 'fluid_audio'],
  ['mlxWhisper', 'mlx_whisper'],
  ['whisperCpp', 'whisper_cpp'],
  ['nativeSpeech', 'native_speech'],
];

export async function GET() {
  const health = await probeJson<{ ok?: boolean }>('/health');
  if (!health?.ok) {
    return NextResponse.json({ available: false } satisfies VoiceStatusResponse);
  }

  const [backends, devices, speech] = await Promise.all([
    probeJson<{ ok?: boolean; available?: Record<string, boolean> }>('/api/stt/backends'),
    probeJson<{ ok?: boolean; devices?: VoiceInputDevice[] }>('/api/input-devices'),
    probeJson<{ ok?: boolean; speech?: VoiceSpeechState }>('/api/speech/state'),
  ]);

  const sttBackends = backends?.ok
    ? BACKEND_IDS.filter(([key]) => backends.available?.[key]).map(([, id]) => id)
    : undefined;
  const inputDevices = devices?.ok && Array.isArray(devices.devices) ? devices.devices : undefined;

  const payload: VoiceStatusResponse = {
    available: true,
    sttBackends,
    inputDevices,
    speech: speech?.ok ? speech.speech : undefined,
  };
  return NextResponse.json(payload);
}
