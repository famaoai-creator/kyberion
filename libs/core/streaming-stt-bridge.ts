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
import {
  getSeamSelectionPolicy,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';
import {
  primaryLanguageSubtag,
  supportsSpeechLanguage,
  WHISPER_LANGUAGES,
} from './speech-languages.js';

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

export const STREAMING_STT_SEAM = 'streaming-stt-bridge';

/** What a streaming bridge can do; unset fields are "not declared". */
export interface StreamingSttCapabilities {
  /** Audio never leaves the machine. Unset for operator commands (may be cloud). */
  local_only?: boolean;
  /** Primary language subtags it transcribes; unset = not filtered by language. */
  languages?: string[];
  /** Emits synthetic text (the stub), not a transcription of the audio. */
  synthetic?: boolean;
}

/**
 * Declared capabilities of bridge ids registered without capabilities (the
 * voice-actuator loopback adapters); a registration may pass its own. `shell` stays undeclared on purpose: the
 * operator command may be a cloud CLI and may be single-language.
 */
const KNOWN_STREAMING_STT_CAPABILITIES: Record<string, StreamingSttCapabilities> = {
  stub: { synthetic: true, local_only: true },
  mlx_whisper: { local_only: true, languages: [...WHISPER_LANGUAGES] },
  faster_whisper: { local_only: true, languages: [...WHISPER_LANGUAGES] },
};

const streamingSttSeam = createSeam<() => StreamingSpeechToTextBridge>({
  key: 'streaming-stt-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});
const streamingSttDisposers = new Map<string, () => void>();
const streamingSttCapabilities = new Map<string, StreamingSttCapabilities>();

export function registerStreamingSttBridge(
  id: string,
  factory: () => StreamingSpeechToTextBridge,
  capabilities?: StreamingSttCapabilities
): () => void {
  const seamDispose = streamingSttSeam.register(id, factory, {
    provenance: 'builtin',
    source: 'streaming-stt-bridge',
  });
  if (capabilities) streamingSttCapabilities.set(id, capabilities);
  else streamingSttCapabilities.delete(id);
  const dispose = () => {
    seamDispose();
    if (streamingSttDisposers.get(id) === dispose) {
      streamingSttDisposers.delete(id);
      streamingSttCapabilities.delete(id);
    }
  };
  streamingSttDisposers.set(id, dispose);
  return dispose;
}

/** Declared capabilities of a bridge id (registration first, then known ids). */
export function getStreamingSttBridgeCapabilities(id: string): StreamingSttCapabilities {
  return streamingSttCapabilities.get(id) ?? KNOWN_STREAMING_STT_CAPABILITIES[id] ?? {};
}

/** Every bridge id getStreamingSttBridge() can return: the stub plus registered ones. */
export function listStreamingSttBridges(): string[] {
  const ids = streamingSttSeam.list().map((provider) => provider.id);
  return ['stub', ...ids.filter((id) => id !== 'stub').sort()];
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

/** Hard needs of a streaming transcription task. */
export interface StreamingSttRequirements {
  /** Audio must stay on this machine (bridge declares `local_only: true`). */
  localOnly?: boolean;
  /** BCP-47 language; bridges declaring other languages are ineligible. */
  language?: string;
  /** Allow synthetic output (the stub). Default false. */
  allowSynthetic?: boolean;
}

export interface SelectStreamingSttBridgeOptions {
  /** Explicit bridge id; wins like KYBERION_STREAMING_STT_BRIDGE. */
  bridgeId?: string;
  purpose?: string;
  requires?: StreamingSttRequirements;
  /** Request facts operator rules may match on; `language` defaults from requires. */
  context?: Record<string, string>;
}

export interface StreamingSttSelection {
  bridge_id: string;
  bridge: StreamingSpeechToTextBridge;
  /** explicit: id / env named it; selected: seam decision; default: today's stub default. */
  source: 'explicit' | 'selected' | 'default';
  /** Present when seam selection ran (also when nothing was eligible). */
  decision?: SeamProviderDecision;
}

function unmetStreamingSttRequirements(id: string, requires: StreamingSttRequirements): string[] {
  const capabilities = getStreamingSttBridgeCapabilities(id);
  const unmet: string[] = [];
  if (capabilities.synthetic && !requires.allowSynthetic)
    unmet.push('synthetic output not allowed');
  if (requires.localOnly && capabilities.local_only !== true) unmet.push('local_only');
  if (!supportsSpeechLanguage(capabilities.languages, requires.language)) {
    unmet.push(`language (${primaryLanguageSubtag(requires.language)})`);
  }
  return unmet;
}

/** Selection candidates (id, eligible, unmet) over the stub and registered bridges. */
export function listStreamingSttCandidates(
  requires: StreamingSttRequirements = {}
): Array<{ id: string; eligible: boolean; unmet: string[] }> {
  return listStreamingSttBridges().map((id) => {
    const unmet = unmetStreamingSttRequirements(id, requires);
    return { id, eligible: unmet.length === 0, unmet };
  });
}

/**
 * Choose the streaming STT bridge for a task.
 *
 * Explicit ids (`bridgeId`, `KYBERION_STREAMING_STT_BRIDGE`) always win.
 * Otherwise the seam policy decides when a purpose is given, an operator rule
 * matches this request, or the task cannot use the default stub (synthetic
 * output not allowed) — the stub cannot transcribe real audio, so such tasks
 * rank the registered bridges with the policy's fallback purpose. Without any
 * of these the stub stays the default, exactly as getStreamingSttBridge().
 * When nothing is eligible the stub is returned with the unresolved decision
 * so callers that require real STT can fail with their own message.
 */
export function selectStreamingSttBridge(
  options: SelectStreamingSttBridgeOptions = {}
): StreamingSttSelection {
  const explicit =
    options.bridgeId?.trim() || getRegisteredEnvText('KYBERION_STREAMING_STT_BRIDGE')?.trim();
  if (explicit) {
    return { bridge_id: explicit, bridge: getStreamingSttBridge(explicit), source: 'explicit' };
  }
  const purpose = options.purpose?.trim() || undefined;
  const requires = options.requires ?? {};
  const language = primaryLanguageSubtag(requires.language);
  const context = { ...(language ? { language } : {}), ...(options.context ?? {}) };
  const stubUnusable = unmetStreamingSttRequirements('stub', requires).length > 0;
  const shouldSelect =
    Boolean(purpose) ||
    Boolean(matchSeamSelectionRule(STREAMING_STT_SEAM, { context })) ||
    (stubUnusable && Boolean(getSeamSelectionPolicy(STREAMING_STT_SEAM)?.fallback_purpose));
  if (!shouldSelect) {
    return { bridge_id: 'stub', bridge: getStreamingSttBridge('stub'), source: 'default' };
  }
  const candidates = listStreamingSttCandidates(requires);
  const decision = resolveSeamProviderDecision({
    seam: STREAMING_STT_SEAM,
    candidates,
    ...(purpose ? { purpose } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    decisionKey: purpose || 'default',
  });
  if (decision.strategy === 'unresolved' || !decision.provider_id) {
    const known = listSeamSelectionPurposes(STREAMING_STT_SEAM);
    if (purpose && !known.includes(purpose)) {
      throw new Error(
        `[streaming-stt] unknown purpose '${purpose}' for seam '${STREAMING_STT_SEAM}' (known: ${known.join(', ')})`
      );
    }
    return {
      bridge_id: 'stub',
      bridge: getStreamingSttBridge('stub'),
      source: 'default',
      decision,
    };
  }
  return {
    bridge_id: decision.provider_id,
    bridge: getStreamingSttBridge(decision.provider_id),
    source: 'selected',
    decision,
  };
}
