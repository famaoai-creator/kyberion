import { describe, expect, it } from 'vitest';
import {
  GeminiMultimodalLiveClient,
  FREE_TIER_AUDIO_MAX_MS,
  FREE_TIER_VIDEO_MAX_MS,
} from './gemini-live-client.js';

describe('GeminiMultimodalLiveClient', () => {
  it('builds valid WebSocket URL and setup payload', () => {
    const client = new GeminiMultimodalLiveClient({
      apiKey: 'test-api-key',
      model: 'gemini-3.8-flash',
      voiceName: 'Kore',
      systemInstruction: 'You are a helpful assistant.',
    });

    const url = client.buildWebSocketUrl();
    expect(url).toContain('wss://generativelanguage.googleapis.com/');
    expect(url).toContain('key=test-api-key');

    const setup = client.buildSetupMessage();
    expect(setup).toEqual({
      setup: {
        model: 'models/gemini-3.8-flash',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore',
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: 'You are a helpful assistant.' }],
        },
      },
    });
  });

  it('formats audio and video chunks properly for realtime streaming', () => {
    const client = new GeminiMultimodalLiveClient({ apiKey: 'dummy' });

    const pcmData = new Uint8Array([0, 1, 2, 3]);
    const audioChunk = client.buildRealtimeAudioChunk(pcmData) as any;
    expect(audioChunk.realtimeInput.mediaChunks[0].mimeType).toBe('audio/pcm;rate=16000');
    expect(audioChunk.realtimeInput.mediaChunks[0].data).toBe(
      Buffer.from(pcmData).toString('base64')
    );

    const jpegData = new Uint8Array([255, 216, 255]);
    const videoChunk = client.buildRealtimeVideoChunk(jpegData) as any;
    expect(videoChunk.realtimeInput.mediaChunks[0].mimeType).toBe('image/jpeg');
    expect(videoChunk.realtimeInput.mediaChunks[0].data).toBe(
      Buffer.from(jpegData).toString('base64')
    );
    expect(client.sessionState.hasVideoInput).toBe(true);
  });

  it('enforces free-tier session expiry caps (15m for audio, 2m for video)', () => {
    const client = new GeminiMultimodalLiveClient({ apiKey: 'dummy' });

    // Audio only
    expect(client.checkSessionExpiry(10 * 60 * 1000).expired).toBe(false);
    expect(client.checkSessionExpiry(FREE_TIER_AUDIO_MAX_MS).expired).toBe(true);

    // Video stream added
    client.buildRealtimeVideoChunk(new Uint8Array([1, 2, 3]));
    expect(client.checkSessionExpiry(1 * 60 * 1000).expired).toBe(false);
    expect(client.checkSessionExpiry(FREE_TIER_VIDEO_MAX_MS).expired).toBe(true);
    expect(client.checkSessionExpiry(FREE_TIER_VIDEO_MAX_MS).reason).toContain('with video');
  });

  it('supports custom session limits and disabling expiry', () => {
    const client = new GeminiMultimodalLiveClient({
      apiKey: 'dummy',
      audioLimitMs: 60 * 1000, // 1 minute custom
    });
    expect(client.checkSessionExpiry(30 * 1000).expired).toBe(false);
    expect(client.checkSessionExpiry(60 * 1000).expired).toBe(true);

    const unlimitedClient = new GeminiMultimodalLiveClient({
      apiKey: 'dummy',
      audioLimitMs: 0, // Disabled
    });
    expect(unlimitedClient.checkSessionExpiry(9999999).expired).toBe(false);
  });

  it('dispatches incoming PCM audio chunks and text to callbacks', () => {
    let receivedAudio: Uint8Array | null = null;
    let receivedText = '';

    const client = new GeminiMultimodalLiveClient({
      apiKey: 'dummy',
      onAudioChunk: (pcm) => {
        receivedAudio = pcm;
      },
      onTextDelta: (text) => {
        receivedText += text;
      },
    });

    const mockServerMsg = {
      serverContent: {
        modelTurn: {
          parts: [
            { text: 'Hello ' },
            { text: 'there!' },
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: Buffer.from([10, 20, 30]).toString('base64'),
              },
            },
          ],
        },
      },
    };

    client.handleIncomingServerMessage(mockServerMsg);
    expect(receivedText).toBe('Hello there!');
    expect(receivedAudio).toEqual(new Uint8Array([10, 20, 30]));
  });
});
