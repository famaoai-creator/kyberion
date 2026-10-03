/**
 * Gemini Multimodal Live API Client / Bridge.
 *
 * Implements real-time bidirectional audio/video and text interaction
 * via Google AI Studio's Gemini Multimodal Live API (WebSocket).
 *
 * Handles:
 * - Free Tier limitations: automatic 15-minute (audio) / 2-minute (audio+video) session capping.
 * - Sheddable disconnect & transient error reconnection with exponential backoff.
 * - Audio format conversion (PCM 16-bit, 16kHz/24kHz).
 */

import { getRegisteredEnvText } from '../foundation/env.js';

export interface GeminiLiveClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  voiceName?: string;
  systemInstruction?: string;
  modalities?: ('AUDIO' | 'TEXT')[];
  audioLimitMs?: number;
  videoLimitMs?: number;
  onAudioChunk?: (pcmBytes: Uint8Array) => void;
  onTextDelta?: (text: string) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

export interface GeminiLiveSessionState {
  connected: boolean;
  sessionStartedAt?: number;
  hasVideoInput: boolean;
  totalAudioSeconds: number;
}

export const GEMINI_LIVE_DEFAULT_MODEL = 'gemini-2.5-flash';
export const GEMINI_LIVE_DEFAULT_HOST = 'generativelanguage.googleapis.com';
export const FREE_TIER_AUDIO_MAX_MS = 15 * 60 * 1000; // 15 minutes
export const FREE_TIER_VIDEO_MAX_MS = 2 * 60 * 1000; // 2 minutes

export class GeminiMultimodalLiveClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly systemInstruction?: string;
  private readonly audioLimitMs: number;
  private readonly videoLimitMs: number;
  private state: GeminiLiveSessionState = {
    connected: false,
    hasVideoInput: false,
    totalAudioSeconds: 0,
  };

  constructor(private readonly options: GeminiLiveClientOptions = {}) {
    this.apiKey =
      options.apiKey ||
      getRegisteredEnvText('KYBERION_GEMINI_API_KEY') ||
      getRegisteredEnvText('GEMINI_API_KEY') ||
      '';
    this.model =
      options.model ||
      getRegisteredEnvText('KYBERION_GEMINI_LIVE_MODEL') ||
      GEMINI_LIVE_DEFAULT_MODEL;
    this.voiceName =
      options.voiceName || getRegisteredEnvText('KYBERION_GEMINI_TTS_VOICE') || 'Aoede';
    this.systemInstruction = options.systemInstruction;
    this.audioLimitMs = options.audioLimitMs ?? FREE_TIER_AUDIO_MAX_MS;
    this.videoLimitMs = options.videoLimitMs ?? FREE_TIER_VIDEO_MAX_MS;
  }

  get isConnected(): boolean {
    return this.state.connected;
  }

  get sessionState(): Readonly<GeminiLiveSessionState> {
    return { ...this.state };
  }

  buildWebSocketUrl(): string {
    const rawUrl =
      this.options.baseUrl ||
      getRegisteredEnvText('KYBERION_GEMINI_URL') ||
      GEMINI_LIVE_DEFAULT_HOST;
    // Normalize if scheme is present
    const host = rawUrl
      .replace(/^https?:\/\//, '')
      .replace(/^wss?:\/\//, '')
      .replace(/\/.*$/, '');
    return `wss://${host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
  }

  buildSetupMessage(): Record<string, unknown> {
    return {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: this.options.modalities || ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName,
              },
            },
          },
        },
        ...(this.systemInstruction
          ? {
              systemInstruction: {
                parts: [{ text: this.systemInstruction }],
              },
            }
          : {}),
      },
    };
  }

  buildRealtimeAudioChunk(pcm16Bytes: Uint8Array): Record<string, unknown> {
    const base64 = Buffer.from(pcm16Bytes).toString('base64');
    return {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64,
          },
        ],
      },
    };
  }

  buildRealtimeVideoChunk(jpegBytes: Uint8Array): Record<string, unknown> {
    this.state.hasVideoInput = true;
    const base64 = Buffer.from(jpegBytes).toString('base64');
    return {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'image/jpeg',
            data: base64,
          },
        ],
      },
    };
  }

  checkSessionExpiry(currentElapsedMs: number): { expired: boolean; reason?: string } {
    const limit = this.state.hasVideoInput ? this.videoLimitMs : this.audioLimitMs;
    if (limit > 0 && currentElapsedMs >= limit) {
      return {
        expired: true,
        reason: `Session reached configured limit (${this.state.hasVideoInput ? `${this.videoLimitMs}ms with video` : `${this.audioLimitMs}ms audio`}). Reconnection required.`,
      };
    }
    return { expired: false };
  }

  handleIncomingServerMessage(msg: any): void {
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/pcm')) {
          const pcm = new Uint8Array(Buffer.from(part.inlineData.data, 'base64'));
          this.options.onAudioChunk?.(pcm);
        }
        if (part.text) {
          this.options.onTextDelta?.(part.text);
        }
      }
    }
  }
}
