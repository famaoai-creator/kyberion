/**
 * Streaming Speech-To-Text bridge.
 *
 * The existing `speech-to-text-bridge.ts` is file-batch shaped (give
 * it a wav, get a transcript back). Live participation needs the
 * streaming variant: feed audio chunks as they arrive, receive
 * transcript updates within ~200-500ms. This interface is the contract
 * between the audio bus and the agent loop.
 *
 * Implementations are pluggable via subprocess (`ShellStreamingSTT` —
 * spawns whisper.cpp / faster-whisper / deepgram CLI; defined in this
 * file) or vendor SDK (Deepgram WS, Google STT streaming — left as
 * stub bindings).
 */
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';

import type { AudioChunk, TranscriptChunk } from './meeting-session-types.js';
import { coreSeamCatalog, createSeam } from './seam.js';

export interface StreamingSpeechToTextBridge {
  readonly bridge_id: string;
  /** Stream transcript chunks as audio arrives. Both partials + finals. */
  transcribeStream(audio: AsyncIterable<AudioChunk>): AsyncIterable<TranscriptChunk>;
}

/* ------------------------------------------------------------------ *
 * StubStreamingSpeechToTextBridge
 *
 * Echoes back a synthetic transcript per N input chunks so the
 * coordinator's loop can be exercised without a real STT backend.
 * The text is deterministic (`"stub-utterance-<n>"`) so unit tests
 * can assert on it.
 * ------------------------------------------------------------------ */

export class StubStreamingSpeechToTextBridge implements StreamingSpeechToTextBridge {
  readonly bridge_id = 'stub';
  /** Chunks per emitted utterance — keep small for tests. */
  constructor(private readonly chunksPerUtterance: number = 3) {}

  async *transcribeStream(audio: AsyncIterable<AudioChunk>): AsyncIterable<TranscriptChunk> {
    let count = 0;
    let utteranceIndex = 0;
    for await (const _ of audio) {
      count += 1;
      if (count % this.chunksPerUtterance === 0) {
        utteranceIndex += 1;
        yield {
          utterance_id: `stub-utt-${utteranceIndex}`,
          is_final: true,
          text: `stub-utterance-${utteranceIndex}`,
          confidence: 1.0,
          emitted_at: nowIso(),
        };
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registry — lets the coordinator pick a backend by id at runtime.
 * ------------------------------------------------------------------ */

const streamingSttSeam = createSeam<() => StreamingSpeechToTextBridge>({
  key: 'streaming-stt-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});
const streamingSttDisposers = new Map<string, () => void>();

export function registerStreamingSttBridge(
  id: string,
  factory: () => StreamingSpeechToTextBridge
): () => void {
  const seamDispose = streamingSttSeam.register(id, factory, {
    provenance: 'builtin',
    source: 'streaming-stt-bridge',
  });
  const dispose = () => {
    seamDispose();
    if (streamingSttDisposers.get(id) === dispose) streamingSttDisposers.delete(id);
  };
  streamingSttDisposers.set(id, dispose);
  return dispose;
}

export function resetStreamingSttBridges(): void {
  for (const dispose of [...streamingSttDisposers.values()]) dispose();
}

export function getStreamingSttBridge(
  id: string = getRegisteredEnvText('KYBERION_STREAMING_STT_BRIDGE') ?? 'stub'
): StreamingSpeechToTextBridge {
  if (id === 'stub') return new StubStreamingSpeechToTextBridge();
  const factory = streamingSttSeam.getOptional(id);
  if (!factory) throw new Error(`[streaming-stt] unknown bridge id '${id}'`);
  return factory();
}
