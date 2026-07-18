import { probeNativeTts, speak, type SpeakOptions, type SpeakResult } from './native-tts.js';

export const VOICE_CAPABILITY_BRIDGE_ID = 'voice-capability-bridge' as const;

export interface VoiceCapabilityProbe {
  bridge_id: typeof VOICE_CAPABILITY_BRIDGE_ID;
  platform: string;
  available: boolean;
  reason?: string;
}

export interface VoiceCapabilityBridge {
  readonly bridge_id: typeof VOICE_CAPABILITY_BRIDGE_ID;
  probe(): Promise<VoiceCapabilityProbe>;
  speak(text: string, options?: SpeakOptions): Promise<SpeakResult>;
}

class VoiceCapabilityBridgeImpl implements VoiceCapabilityBridge {
  readonly bridge_id = VOICE_CAPABILITY_BRIDGE_ID;

  async probe(): Promise<VoiceCapabilityProbe> {
    const result = await probeNativeTts();
    return {
      bridge_id: VOICE_CAPABILITY_BRIDGE_ID,
      platform: result.platform,
      available: result.available,
      reason: result.reason,
    };
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    return speak(text, options);
  }
}

export function createVoiceCapabilityBridge(): VoiceCapabilityBridge {
  return new VoiceCapabilityBridgeImpl();
}
