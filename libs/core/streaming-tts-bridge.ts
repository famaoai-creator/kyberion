/**
 * Streaming Text-To-Speech bridge.
 *
 * Mirrors `streaming-stt-bridge.ts` from the other direction: take a
 * stream of text segments, return a stream of PCM audio chunks the
 * audio bus can write to the meeting's mic input. Streaming matters
 * here too — sentence-by-sentence synthesis lets the AI start speaking
 * before the full reply is built, which is the difference between a
 * 200ms response and a 6-second one.
 *
 * Implementations: Piper / Coqui XTTS / ElevenLabs streaming / Azure
 * Neural TTS. We ship a stub + a shell-out adapter; vendor specifics
 * register their own bridge.
 */

import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { executeServicePreset } from './service-engine.js';
import { coreSeamCatalog, createSeam } from './seam.js';
import {
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';

/** What a streaming TTS bridge can do; used only for governed selection. */
export interface StreamingTtsCapabilities {
  /** BCP-47 primary subtags the bridge speaks, or ['*'] when unknown / host-defined. */
  languages: string[];
  /** Text never leaves the machine. */
  local_only: boolean;
  /** Emits placeholder bytes rather than real speech (the stub). */
  synthetic?: boolean;
}

export interface StreamingTextToSpeechBridge {
  readonly bridge_id: string;
  /** Audio format the bridge emits; coordinators must match it. */
  readonly format: AudioFormat;
  /** Declared capabilities; bridges without them count as ['*'], not local. */
  readonly capabilities?: StreamingTtsCapabilities;
  /**
   * Synthesize a stream of text segments into a stream of PCM chunks.
   * `voice_profile_id` ties back to `voice-profile-registry.json`.
   */
  synthesizeStream(
    text: AsyncIterable<string>,
    voice_profile_id: string
  ): AsyncIterable<AudioChunk>;
}

/* ------------------------------------------------------------------ *
 * StubStreamingTextToSpeechBridge
 *
 * Emits one tiny PCM chunk per text segment. Lets the coordinator's
 * "speak then write to bus" path be exercised without a real TTS.
 * ------------------------------------------------------------------ */

export class StubStreamingTextToSpeechBridge implements StreamingTextToSpeechBridge {
  readonly bridge_id = 'stub';
  readonly format: AudioFormat = {
    encoding: 'pcm_s16le',
    sample_rate_hz: 16000,
    channels: 1,
  };
  readonly capabilities: StreamingTtsCapabilities = {
    languages: ['*'],
    local_only: true,
    synthetic: true,
  };

  async *synthesizeStream(
    text: AsyncIterable<string>,
    _voice_profile_id: string
  ): AsyncIterable<AudioChunk> {
    let ts = 0;
    for await (const segment of text) {
      const payload = new Uint8Array(Buffer.from(segment, 'utf8'));
      yield { format: this.format, payload, ts_ms: ts };
      ts += 200;
    }
  }
}

export class GeminiStreamingTextToSpeechBridge implements StreamingTextToSpeechBridge {
  readonly bridge_id = 'gemini';
  readonly format: AudioFormat = {
    encoding: 'pcm_s16le',
    sample_rate_hz: 24000,
    channels: 1,
  };
  // Same basis as knowledge/product/governance/voice-engines/gemini_tts.json:
  // upstream auto-detects more languages; only en/ja are exercised here.
  readonly capabilities: StreamingTtsCapabilities = {
    languages: ['en', 'ja'],
    local_only: false,
  };

  constructor(private readonly opts: { voice?: string } = {}) {}

  async *synthesizeStream(
    text: AsyncIterable<string>,
    _voice_profile_id: string
  ): AsyncIterable<AudioChunk> {
    let prompt = '';
    for await (const segment of text) {
      prompt += segment;
    }
    const voice = this.opts.voice || getRegisteredEnvText('KYBERION_GEMINI_TTS_VOICE') || 'Kore';
    const result = await executeServicePreset(
      'gemini',
      'generate_tts',
      {
        text: prompt.trim(),
        voice,
      },
      'secret-guard'
    );
    const audioData =
      typeof result === 'string'
        ? result
        : (result as any)?.audioData ||
          (result as any)?.output_audio?.data ||
          (result as any)?.result?.audioData;
    if (!audioData || typeof audioData !== 'string') {
      throw new Error('Gemini TTS service returned no audio data');
    }
    yield {
      format: this.format,
      payload: new Uint8Array(Buffer.from(audioData, 'base64')),
      ts_ms: Date.now(),
    };
  }
}

const streamingTtsSeam = createSeam<() => StreamingTextToSpeechBridge>({
  key: 'streaming-tts-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});
const streamingTtsDisposers = new Map<string, () => void>();

export function registerStreamingTtsBridge(
  id: string,
  factory: () => StreamingTextToSpeechBridge
): () => void {
  const seamDispose = streamingTtsSeam.register(id, factory, {
    provenance: 'builtin',
    source: 'streaming-tts-bridge',
  });
  const dispose = () => {
    seamDispose();
    if (streamingTtsDisposers.get(id) === dispose) streamingTtsDisposers.delete(id);
  };
  streamingTtsDisposers.set(id, dispose);
  return dispose;
}

export function resetStreamingTtsBridges(): void {
  for (const dispose of [...streamingTtsDisposers.values()]) dispose();
}

export function getStreamingTtsBridge(
  id: string = getRegisteredEnvText('KYBERION_STREAMING_TTS_BRIDGE') ?? 'stub'
): StreamingTextToSpeechBridge {
  if (id === 'stub') return new StubStreamingTextToSpeechBridge();
  if (id === 'gemini') return new GeminiStreamingTextToSpeechBridge();
  const factory = streamingTtsSeam.getOptional(id);
  if (!factory) throw new Error(`[streaming-tts] unknown bridge id '${id}'`);
  return factory();
}

/* ------------------------------------------------------------------ *
 * streaming-tts-bridge seam: governed selection.
 * KYBERION_STREAMING_TTS_BRIDGE (or an explicit id) always wins.
 * ------------------------------------------------------------------ */

export const STREAMING_TTS_SEAM = 'streaming-tts-bridge';

export function getStreamingTtsCapabilities(
  bridge: StreamingTextToSpeechBridge
): StreamingTtsCapabilities {
  return bridge.capabilities ?? { languages: ['*'], local_only: false };
}

/** Hard needs of a streaming synthesis task. */
export interface StreamingTtsRequirements {
  /** Language of the text (primary subtag). */
  language?: string;
  /** Text must stay on this machine. */
  localOnly?: boolean;
  /** Allow the synthetic stub. Default true (it is today's default bridge). */
  allowSynthetic?: boolean;
}

export function unmetStreamingTtsRequirements(
  bridge: StreamingTextToSpeechBridge,
  requires: StreamingTtsRequirements
): string[] {
  const capabilities = getStreamingTtsCapabilities(bridge);
  const unmet: string[] = [];
  if (capabilities.synthetic && requires.allowSynthetic === false) {
    unmet.push('synthetic output not allowed');
  }
  const language = String(requires.language ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/u)[0];
  if (
    language &&
    !capabilities.languages.includes('*') &&
    !capabilities.languages.includes(language)
  ) {
    unmet.push(`language ${language}`);
  }
  if (requires.localOnly && !capabilities.local_only) unmet.push('local_only');
  return unmet;
}

/** Built-in bridges plus every registered named bridge. */
export function listStreamingTtsBridges(): StreamingTextToSpeechBridge[] {
  const bridges: StreamingTextToSpeechBridge[] = [
    new StubStreamingTextToSpeechBridge(),
    new GeminiStreamingTextToSpeechBridge(),
  ];
  for (const record of streamingTtsSeam.list()) {
    if (record.id === 'stub' || record.id === 'gemini') continue;
    bridges.push(record.implementation());
  }
  return bridges;
}

export interface SelectStreamingTtsBridgeOptions {
  purpose?: string;
  requires?: StreamingTtsRequirements;
  /** Bridges to choose from. Default: listStreamingTtsBridges(). */
  bridges?: StreamingTextToSpeechBridge[];
  context?: Record<string, string>;
}

export interface StreamingTtsSelection {
  bridge: StreamingTextToSpeechBridge;
  /** Eligible bridges, best first. */
  ranked: StreamingTextToSpeechBridge[];
  decision: SeamProviderDecision;
}

export class StreamingTtsSelectionError extends Error {
  constructor(readonly decision: SeamProviderDecision) {
    super(`[STREAMING_TTS_SELECTION] ${decision.rationale}`);
    this.name = 'StreamingTtsSelectionError';
  }
}

/** Purpose-driven choice among the bridges' declared capabilities; audited and pinned. */
export function selectStreamingTtsBridge(
  options: SelectStreamingTtsBridgeOptions = {}
): StreamingTtsSelection {
  const purpose = String(options.purpose || '').trim() || undefined;
  if (purpose) {
    const known = listSeamSelectionPurposes(STREAMING_TTS_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[STREAMING_TTS_SELECTION] unknown purpose '${purpose}' for seam '${STREAMING_TTS_SEAM}' (known: ${known.join(', ')})`
      );
    }
  }
  const requires = options.requires ?? {};
  const bridges = options.bridges ?? listStreamingTtsBridges();
  const language = String(requires.language ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/u)[0];
  const context = { ...(language ? { language } : {}), ...(options.context ?? {}) };
  const decision = resolveSeamProviderDecision({
    seam: STREAMING_TTS_SEAM,
    candidates: bridges.map((bridge) => {
      const unmet = unmetStreamingTtsRequirements(bridge, requires);
      return { id: bridge.bridge_id, eligible: unmet.length === 0, unmet };
    }),
    ...(purpose ? { purpose } : {}),
    ...(Object.keys(context).length ? { context } : {}),
    decisionKey: purpose ?? 'default',
  });
  if (decision.strategy === 'unresolved') throw new StreamingTtsSelectionError(decision);
  const byId = new Map(bridges.map((bridge) => [bridge.bridge_id, bridge]));
  const ranked = decision.ranked.flatMap((id) => byId.get(id) ?? []);
  return { bridge: ranked[0]!, ranked, decision };
}

export interface ResolveStreamingTtsBridgeOptions extends Omit<
  SelectStreamingTtsBridgeOptions,
  'bridges'
> {
  /** Explicit bridge id; wins over everything (as KYBERION_STREAMING_TTS_BRIDGE does). */
  bridgeId?: string;
}

/**
 * The bridge a caller should use. Explicit id / KYBERION_STREAMING_TTS_BRIDGE
 * wins; governed selection runs only with a purpose, an operator rule that
 * matches this request, or when the default stub cannot run the task
 * (synthetic disallowed).
 * Otherwise identical to getStreamingTtsBridge().
 */
export function resolveStreamingTtsBridge(
  options: ResolveStreamingTtsBridgeOptions = {}
): StreamingTextToSpeechBridge {
  const explicit =
    options.bridgeId?.trim() || getRegisteredEnvText('KYBERION_STREAMING_TTS_BRIDGE')?.trim();
  if (explicit) return getStreamingTtsBridge(explicit);
  const defaultBridge = new StubStreamingTextToSpeechBridge();
  const defaultUnmet = unmetStreamingTtsRequirements(defaultBridge, options.requires ?? {});
  const language = String(options.requires?.language ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/u)[0];
  const context = { ...(language ? { language } : {}), ...(options.context ?? {}) };
  const shouldSelect =
    Boolean(String(options.purpose || '').trim()) ||
    Boolean(matchSeamSelectionRule(STREAMING_TTS_SEAM, { context })) ||
    defaultUnmet.length > 0;
  if (!shouldSelect) return defaultBridge;
  return selectStreamingTtsBridge(options).bridge;
}
