import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { pcmToWav } from './pcm-wav.js';
import type { TraceContext } from './src/trace.js';
import type { AudioBus } from './audio-bus.js';
import type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import type { AudioChunk, AudioFormat, TranscriptChunk } from './meeting-session-types.js';
import { chunkDurationMs, pcmSignalMetrics } from './audio-route.js';
import { compareAudioText } from './audio-text-similarity.js';

export interface TtsLoopbackVerificationRequest {
  request_id: string;
  mission_id?: string;
  tenant_slug?: string;
  text: string;
  expected_text?: string;
  language?: string;
  voice_profile_id?: string;
  audio_route: {
    bus: 'blackhole' | 'stub';
    input_device_uid?: string;
    output_device_uid?: string;
    expected_device_label?: string;
  };
  format?: {
    encoding: 'pcm_s16le';
    sample_rate_hz: 16000 | 24000 | 48000;
    channels: 1 | 2;
  };
  timing?: {
    pre_roll_ms?: number;
    post_roll_ms?: number;
    max_duration_ms?: number;
    silence_timeout_ms?: number;
  };
  quality?: {
    minimum_similarity?: number;
    minimum_confidence?: number;
    maximum_clipping_ratio?: number;
    maximum_drop_ratio?: number;
  };
  persistence?: {
    retain_audio?: boolean;
    retain_transcript?: boolean;
    output_dir?: string;
  };
  dry_run?: boolean;
}

export interface TtsSource {
  readonly bridge_id: string;
  readonly engine_id?: string;
  synthesize(
    text: string,
    voiceProfileId?: string,
    signal?: AbortSignal
  ): AsyncIterable<AudioChunk>;
}

export interface LoopbackVerifierOptions {
  bus: AudioBus;
  tts: TtsSource;
  stt: StreamingSpeechToTextBridge;
  trace?: TraceContext;
  checkConsent?: () => { allowed: boolean; reason?: string };
  now?: () => number;
}

export interface TtsLoopbackVerificationReceipt {
  kind: 'tts-loopback-verification';
  source: 'self_tts_loopback';
  request_id: string;
  status: 'passed' | 'failed' | 'blocked' | 'canceled';
  started_at: string;
  completed_at: string;
  route: {
    bus_id: string;
    input_device_uid?: string;
    input_device_name?: string;
    output_device_uid?: string;
    output_device_name?: string;
  };
  audio_format: AudioFormat;
  tts: {
    bridge_id: string;
    engine_id?: string;
    voice_profile_id?: string;
    chars: number;
    first_audio_ms?: number;
    synthesis_ms?: number;
  };
  capture: {
    captured_ms: number;
    chunks: number;
    dropped_chunks: number;
    resampled?: boolean;
    rms_peak?: number;
    clipping_ratio?: number;
    silence_ratio?: number;
  };
  stt: {
    bridge_id: string;
    backend?: string;
    transcript: string;
    confidence?: number;
    first_partial_ms?: number;
    final_ms?: number;
  };
  verification: {
    expected_normalized: string;
    actual_normalized: string;
    similarity: number;
    character_error_rate: number;
    word_error_rate: number;
    normalized_exact_match: boolean;
    passed: boolean;
    missing_spans: string[];
    unexpected_spans: string[];
    reasons: string[];
  };
  artifacts?: {
    audio_ref?: string;
    transcript_ref?: string;
    receipt_ref?: string;
    trace_ref?: string;
  };
  security: {
    consent_checked: boolean;
    audio_retained: boolean;
    transcript_retained: boolean;
    tier?: string;
  };
  warnings: string[];
}

const DEFAULT_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };

export class TtsLoopbackVerifier {
  constructor(private readonly options: LoopbackVerifierOptions) {}

  async verify(request: TtsLoopbackVerificationRequest): Promise<TtsLoopbackVerificationReceipt> {
    const now = this.options.now ?? Date.now;
    const startedMs = now();
    const format = toAudioFormat(request.format);
    const warnings: string[] = [];
    const expectedText = request.expected_text ?? request.text;
    const base = this.emptyReceipt(request, format, startedMs);
    if (!request.request_id.trim() || !request.text.trim()) {
      return this.finish(
        {
          ...base,
          status: 'failed',
          verification: failureVerification(expectedText, 'request_id and text are required'),
        },
        now()
      );
    }
    if (
      request.audio_route.bus !== this.options.bus.bus_id &&
      !(request.audio_route.bus === 'stub' && this.options.bus.bus_id === 'stub')
    ) {
      return this.finish(
        {
          ...base,
          status: 'blocked',
          verification: failureVerification(
            expectedText,
            `requested bus '${request.audio_route.bus}' does not match '${this.options.bus.bus_id}'`
          ),
        },
        now()
      );
    }
    if (request.dry_run) {
      return this.finish(
        {
          ...base,
          status: 'blocked',
          security: { ...base.security, consent_checked: false },
          warnings: ['dry_run: no audio output, capture, or STT was executed'],
          verification: failureVerification(expectedText, 'dry_run'),
        },
        now()
      );
    }
    const consent = this.options.checkConsent?.() ?? {
      allowed: false,
      reason: 'operator consent is required before audio output',
    };
    if (!consent.allowed) {
      return this.finish(
        {
          ...base,
          status: 'blocked',
          security: { ...base.security, consent_checked: true },
          verification: failureVerification(
            expectedText,
            consent.reason || 'audio output consent denied'
          ),
        },
        now()
      );
    }

    const routeProbe = await this.options.bus.probe();
    if (!routeProbe.available) {
      return this.finish(
        {
          ...base,
          status: 'blocked',
          route: {
            bus_id: routeProbe.bus_id,
            ...(routeProbe.device_descriptors?.find(
              (device) => device.direction === 'input' || device.direction === 'duplex'
            )
              ? {
                  input_device_uid: routeProbe.device_descriptors.find(
                    (device) => device.direction === 'input' || device.direction === 'duplex'
                  )?.uid,
                }
              : {}),
            ...(routeProbe.device_descriptors?.find(
              (device) => device.direction === 'output' || device.direction === 'duplex'
            )
              ? {
                  output_device_uid: routeProbe.device_descriptors.find(
                    (device) => device.direction === 'output' || device.direction === 'duplex'
                  )?.uid,
                }
              : {}),
          },
          warnings: [
            ...warnings,
            routeProbe.reason || 'audio route unavailable',
            ...(routeProbe.warnings || []),
          ],
          verification: failureVerification(
            expectedText,
            routeProbe.reason || 'audio route unavailable'
          ),
        },
        now()
      );
    }

    const captured: AudioChunk[] = [];
    let captureDone = false;
    let capturePromise: Promise<void> = Promise.resolve();
    const maxDurationMs = request.timing?.max_duration_ms ?? 30_000;
    let ttsChunks = 0;
    let firstAudioMs: number | undefined;
    const synthesisStarted = now();
    let outputError: string | undefined;
    try {
      await this.options.bus.open(format);
      capturePromise = (async () => {
        try {
          for await (const chunk of this.options.bus.inputStream()) {
            if (captureDone) break;
            const capturedMs = captured.reduce((total, item) => total + chunkDurationMs(item), 0);
            if (capturedMs >= maxDurationMs) break;
            captured.push(chunk);
          }
        } catch (error) {
          warnings.push(
            `capture failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
      await wait(request.timing?.pre_roll_ms ?? 250);
      const output = this.options.bus.writeOutput(
        this.timedTtsStream(request, format, synthesisStarted, now, () => {
          ttsChunks += 1;
          if (firstAudioMs === undefined) firstAudioMs = now() - synthesisStarted;
        })
      );
      await output;
    } catch (error) {
      outputError = error instanceof Error ? error.message : String(error);
    } finally {
      await wait(request.timing?.post_roll_ms ?? 250);
      captureDone = true;
      await this.options.bus.close().catch((error: unknown) => {
        warnings.push(
          `audio cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      await capturePromise;
    }
    if (outputError) warnings.push(outputError);
    const capturedMs = captured.reduce((total, chunk) => total + chunkDurationMs(chunk), 0);
    const signal = pcmSignalMetrics(captured);
    const busMetrics = this.options.bus.metrics?.();
    const sttStarted = now();
    let transcript = '';
    let confidence: number | undefined;
    let firstPartialMs: number | undefined;
    let finalMs: number | undefined;
    let sttBackend: string | undefined;
    let sttError: string | undefined;
    try {
      for await (const chunk of this.options.stt.transcribeStream(asAudioIterable(captured))) {
        sttBackend = this.options.stt.bridge_id;
        if (firstPartialMs === undefined) firstPartialMs = now() - sttStarted;
        if (chunk.is_final) {
          transcript = transcript ? `${transcript} ${chunk.text}`.trim() : chunk.text.trim();
          confidence =
            typeof chunk.confidence === 'number'
              ? Math.min(confidence ?? 1, chunk.confidence)
              : confidence;
          finalMs = now() - sttStarted;
        }
      }
    } catch (error) {
      sttError = error instanceof Error ? error.message : String(error);
    }
    if (sttError) warnings.push(`STT failed: ${sttError}`);
    const comparison = compareAudioText(expectedText, transcript);
    const reasons: string[] = [];
    if (ttsChunks === 0) reasons.push('TTS produced no audio');
    if (captured.length === 0 || capturedMs < 20)
      reasons.push('BlackHole capture contained no usable audio');
    if (signal.silence_ratio !== undefined && signal.silence_ratio >= 0.99)
      reasons.push('captured audio is silent');
    if (!transcript.trim()) reasons.push('STT returned an empty final transcript');
    if (sttError) reasons.push('STT backend failed');
    if (outputError) reasons.push('audio output failed');
    const droppedChunks = busMetrics?.dropped_chunks ?? 0;
    const dropRatio = droppedChunks / Math.max(1, captured.length + droppedChunks);
    if (
      request.quality?.maximum_drop_ratio !== undefined &&
      dropRatio > request.quality.maximum_drop_ratio
    )
      reasons.push(`audio drop ratio ${dropRatio.toFixed(3)} exceeded limit`);
    if (
      request.quality?.maximum_clipping_ratio !== undefined &&
      (signal.clipping_ratio ?? 0) > request.quality.maximum_clipping_ratio
    )
      reasons.push('captured audio clipping exceeded limit');
    if (
      request.quality?.minimum_confidence !== undefined &&
      (confidence === undefined || confidence < request.quality.minimum_confidence)
    )
      reasons.push('STT confidence was below the configured minimum');
    if (comparison.similarity < (request.quality?.minimum_similarity ?? 0.85))
      reasons.push(
        `text similarity ${comparison.similarity.toFixed(3)} was below the configured minimum`
      );
    const passed =
      reasons.length === 0 &&
      comparison.similarity >= (request.quality?.minimum_similarity ?? 0.85);
    const receipt: TtsLoopbackVerificationReceipt = {
      ...base,
      status: passed ? 'passed' : 'failed',
      completed_at: new Date(now()).toISOString(),
      route: {
        bus_id: routeProbe.bus_id,
        ...(routeProbe.device_descriptors?.find(
          (device) => device.direction === 'input' || device.direction === 'duplex'
        )
          ? {
              input_device_uid: routeProbe.device_descriptors.find(
                (device) => device.direction === 'input' || device.direction === 'duplex'
              )?.uid,
              input_device_name: routeProbe.device_descriptors.find(
                (device) => device.direction === 'input' || device.direction === 'duplex'
              )?.display_name,
            }
          : {}),
        ...(routeProbe.device_descriptors?.find(
          (device) => device.direction === 'output' || device.direction === 'duplex'
        )
          ? {
              output_device_uid: routeProbe.device_descriptors.find(
                (device) => device.direction === 'output' || device.direction === 'duplex'
              )?.uid,
              output_device_name: routeProbe.device_descriptors.find(
                (device) => device.direction === 'output' || device.direction === 'duplex'
              )?.display_name,
            }
          : {}),
      },
      tts: {
        ...base.tts,
        first_audio_ms: firstAudioMs,
        synthesis_ms: now() - synthesisStarted,
      },
      capture: {
        captured_ms: Math.round(capturedMs),
        chunks: captured.length,
        dropped_chunks: droppedChunks,
        resampled: busMetrics?.resampled ?? false,
        rms_peak: signal.input_peak_rms,
        clipping_ratio: signal.clipping_ratio,
        silence_ratio: signal.silence_ratio,
      },
      stt: {
        ...base.stt,
        ...(sttBackend ? { backend: sttBackend } : {}),
        transcript,
        confidence,
        first_partial_ms: firstPartialMs,
        final_ms: finalMs,
      },
      security: {
        consent_checked: true,
        audio_retained: Boolean(request.persistence?.retain_audio),
        transcript_retained: Boolean(request.persistence?.retain_transcript),
        tier: 'confidential',
      },
      verification: {
        expected_normalized: comparison.expected_normalized,
        actual_normalized: comparison.actual_normalized,
        similarity: comparison.similarity,
        character_error_rate: comparison.character_error_rate,
        word_error_rate: comparison.word_error_rate,
        normalized_exact_match: comparison.normalized_exact_match,
        passed,
        missing_spans: comparison.missing_spans,
        unexpected_spans: comparison.unexpected_spans,
        reasons,
      },
      warnings: [...warnings, ...(routeProbe.warnings || [])],
    };
    return this.persist(receipt, captured, request, now());
  }

  private async *timedTtsStream(
    request: TtsLoopbackVerificationRequest,
    format: AudioFormat,
    _startedMs: number,
    _now: () => number,
    onChunk: () => void
  ): AsyncIterable<AudioChunk> {
    for await (const chunk of this.options.tts.synthesize(request.text, request.voice_profile_id)) {
      if (
        chunk.format.encoding !== format.encoding ||
        chunk.format.sample_rate_hz !== format.sample_rate_hz ||
        chunk.format.channels !== format.channels
      ) {
        throw new Error(
          `TTS format mismatch: expected ${format.encoding}/${format.sample_rate_hz}/${format.channels}`
        );
      }
      onChunk();
      yield chunk;
    }
  }

  private emptyReceipt(
    request: TtsLoopbackVerificationRequest,
    format: AudioFormat,
    startedMs: number
  ): TtsLoopbackVerificationReceipt {
    return {
      kind: 'tts-loopback-verification',
      source: 'self_tts_loopback',
      request_id: request.request_id,
      status: 'failed',
      started_at: new Date(startedMs).toISOString(),
      completed_at: new Date(startedMs).toISOString(),
      route: { bus_id: this.options.bus.bus_id },
      audio_format: format,
      tts: {
        bridge_id: this.options.tts.bridge_id,
        ...(this.options.tts.engine_id ? { engine_id: this.options.tts.engine_id } : {}),
        ...(request.voice_profile_id ? { voice_profile_id: request.voice_profile_id } : {}),
        chars: request.text.length,
      },
      capture: { captured_ms: 0, chunks: 0, dropped_chunks: 0 },
      stt: { bridge_id: this.options.stt.bridge_id, transcript: '' },
      verification: failureVerification(
        request.expected_text ?? request.text,
        'verification not run'
      ),
      security: {
        consent_checked: false,
        audio_retained: false,
        transcript_retained: false,
        tier: 'confidential',
      },
      warnings: [],
    };
  }

  private async finish(
    receipt: TtsLoopbackVerificationReceipt,
    completedMs: number
  ): Promise<TtsLoopbackVerificationReceipt> {
    receipt.completed_at = new Date(completedMs).toISOString();
    return this.persist(receipt, [], undefined, completedMs);
  }

  private async persist(
    receipt: TtsLoopbackVerificationReceipt,
    captured: readonly AudioChunk[],
    request: TtsLoopbackVerificationRequest | undefined,
    nowMs: number
  ): Promise<TtsLoopbackVerificationReceipt> {
    const persistence = receipt.status === 'passed' || receipt.status === 'failed';
    const outputDir = resolveOutputDir(receipt.request_id, request?.persistence?.output_dir);
    safeMkdir(outputDir, { recursive: true });
    if (persistence && captured.length > 0) {
      const audioRef = path.join(
        outputDir,
        `${receipt.request_id}.${receipt.audio_format.channels === 1 ? 'wav' : 'pcm'}`
      );
      if (receipt.security.audio_retained) {
        const pcm = Buffer.concat(captured.map((chunk) => Buffer.from(chunk.payload)));
        safeWriteFile(
          audioRef,
          receipt.audio_format.channels === 1
            ? pcmToWav(pcm, receipt.audio_format.sample_rate_hz)
            : pcm
        );
        receipt.artifacts = { ...(receipt.artifacts || {}), audio_ref: audioRef };
      }
      if (receipt.security.transcript_retained && receipt.stt.transcript) {
        const transcriptRef = path.join(outputDir, `${receipt.request_id}.transcript.txt`);
        safeWriteFile(transcriptRef, `${receipt.stt.transcript}\n`);
        receipt.artifacts = { ...(receipt.artifacts || {}), transcript_ref: transcriptRef };
      }
    }
    const receiptRef = path.join(outputDir, `${receipt.request_id}.receipt.json`);
    receipt.artifacts = { ...(receipt.artifacts || {}), receipt_ref: receiptRef };
    safeWriteFile(receiptRef, JSON.stringify(receipt, null, 2));
    void nowMs;
    return receipt;
  }
}

function toAudioFormat(format: TtsLoopbackVerificationRequest['format']): AudioFormat {
  return format
    ? {
        encoding: format.encoding,
        sample_rate_hz: format.sample_rate_hz,
        channels: format.channels,
      }
    : DEFAULT_FORMAT;
}

function failureVerification(
  expected: string,
  reason: string
): TtsLoopbackVerificationReceipt['verification'] {
  const comparison = compareAudioText(expected, '');
  return {
    ...comparison,
    passed: false,
    reasons: [reason],
  };
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function* asAudioIterable(chunks: readonly AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const chunk of chunks) yield chunk;
}

function resolveOutputDir(requestId: string, requestedDir?: string): string {
  const root = pathResolver.rootDir();
  const dir = requestedDir
    ? pathResolver.rootResolve(requestedDir)
    : pathResolver.shared(`runtime/voice-loopback-receipts/${requestId}`);
  const relative = path.relative(root, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('loopback receipt path escaped workspace');
  return dir;
}
