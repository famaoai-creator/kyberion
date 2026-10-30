import { createLogger } from '@agent/core/logger';
import type { SpeechToTextBridge } from '@agent/core/voice/speech-to-text-bridge';
import type { StreamingTextToSpeechBridge } from '@agent/core/voice/streaming-tts-bridge';
import type { AudioChunk } from '@agent/core/meeting/meeting-session-types';

const logger = createLogger('realtime-voice-cleanup');

/** Cleanup must finish every resource and never replace the operation's primary failure. */
export async function cleanupRealtimeVoiceResources(
  actions: ReadonlyArray<{ resource: string; cleanup: () => unknown }>
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map(({ cleanup }) => Promise.resolve().then(cleanup))
  );
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== 'rejected') continue;
    try {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn(
        '[voice-streaming] ' +
          actions[index].resource +
          ' cleanup failed — ' +
          reason +
          ' | next: inspect the resource adapter shutdown | evidence: realtime voice cleanup'
      );
    } catch {
      /* Diagnostic failure must not mask the original operation either. */
    }
  }
}

/** A streaming failure may use real batch STT, never the synthetic stub. */
export async function transcribeRealtimeBatchFallback(
  bridge: SpeechToTextBridge,
  audioPath: string,
  language?: string
): Promise<string> {
  if (bridge.name === 'stub')
    throw new Error('Streaming STT failed and no real batch STT fallback is configured');
  return (await bridge.transcribe({ audioPath, ...(language ? { language } : {}) })).text;
}

/** Require real PCM before starting the conversation; release probes even on timeout. */
export async function smokeTestStreamingTts(
  bridge: StreamingTextToSpeechBridge,
  voiceProfileId: string,
  timeoutMs = 15_000
): Promise<{ ok: boolean; reason?: string }> {
  async function* text(): AsyncGenerator<string> {
    // i18n-exempt: JA voice demo probe
    yield 'テスト。';
  }
  let iterator: AsyncIterator<AudioChunk> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    iterator = bridge.synthesizeStream(text(), voiceProfileId)[Symbol.asyncIterator]();
    const timedOut = Symbol('timeout');
    const first = await Promise.race([
      iterator.next(),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (first === timedOut) {
      await cleanupRealtimeVoiceResources([
        { resource: 'TTS probe bridge', cleanup: () => bridge.dispose?.() },
      ]);
      return { ok: false, reason: 'no PCM within ' + timeoutMs + 'ms' };
    }
    if (first.done) return { ok: false, reason: 'stream closed without audio chunks' };
    if (!first.value.payload.length) return { ok: false, reason: 'empty first audio chunk' };
    return { ok: true };
  } catch (error) {
    await cleanupRealtimeVoiceResources([
      { resource: 'TTS probe bridge', cleanup: () => bridge.dispose?.() },
    ]);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Some generators queue return behind a pending next; dispose above closes
    // native workers, and a late return failure must not become unhandled.
    void cleanupRealtimeVoiceResources([
      { resource: 'TTS probe iterator', cleanup: () => iterator?.return?.() },
    ]);
  }
}
