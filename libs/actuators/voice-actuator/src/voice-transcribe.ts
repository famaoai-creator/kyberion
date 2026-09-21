/**
 * transcribe / transcribe_voice_sample: STT with the governed bridge order
 * (speech-to-text-bridge seam) when a purpose is given or an operator rule
 * matches the request; otherwise today's priority order.
 */

import {
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  normalizeSpeechToTextResult,
  selectSpeechToTextBridges,
  SPEECH_TO_TEXT_SEAM,
  SpeechToTextSelectionError,
} from '@agent/core/speech-to-text-bridge';
import { matchSeamSelectionRule } from '@agent/core/seam-selection-rules';
import { logger } from '@agent/core/core';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { safeExecResult, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveVoicePath } from '@agent/core/voice-path-policy';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseVoiceSttBridgeResponse, resolvePythonBin } from './voice-runtime-helpers.js';
import { ensureSttReadyAudio } from './voice-media-output-helpers.js';

export async function transcribeVoiceSample(input: {
  action: 'transcribe_voice_sample';
  audio_path: string;
  language?: string;
  model?: string;
  write_sidecar?: boolean;
  prefer_timestamps?: boolean;
  backend?: 'auto' | 'bridge' | 'fluid_audio' | 'mlx_whisper';
  allow_synthetic?: boolean;
  /**
   * Governed selection purpose (accuracy / latency / privacy); only used with
   * backend 'auto'. An operator rule matching the request also triggers selection.
   */
  purpose?: string;
}): Promise<any> {
  const audioPath = resolveVoicePath(String(input.audio_path || '').trim(), 'audio-input');
  // Smartphone m4a / Zoom mp4 / mp3 arrive here untouched — normalize to the
  // STT-ready shape (16kHz mono PCM wav) before any bridge sees the file.
  const prepared = ensureSttReadyAudio(audioPath);
  const effectiveAudioPath = prepared.path;
  const preferTimestamps = input.prefer_timestamps !== false;
  const backendPreference = input.backend || 'auto';
  const bridges = getSpeechToTextBridges();
  const candidates: any[] = [];
  const errors: Error[] = [];

  const transcribeWithBridge = async (bridge: any): Promise<any | null> => {
    if (bridge.name === 'stub' && !input.allow_synthetic) return null;
    try {
      const result = normalizeSpeechToTextResult(
        bridge,
        await bridge.transcribe({
          audioPath: effectiveAudioPath,
          ...(input.language ? { language: input.language } : {}),
        })
      );
      const candidate = {
        status: 'succeeded',
        action: 'transcribe_voice_sample',
        audio_path: audioPath,
        ...(prepared.converted ? { normalized_audio_path: effectiveAudioPath } : {}),
        transcript: result.text,
        language: result.language || input.language,
        backend: result.backend || bridge.name,
        capabilities: result.capabilities || getSpeechToTextCapabilities(bridge),
        priority: Number(bridge.priority || 0),
        ...(result.segments ? { segments: result.segments } : {}),
        ...(result.synthetic ? { synthetic: true } : {}),
      };
      candidates.push(candidate);
      return candidate;
    } catch (error: any) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      errors.push(normalized);
      logger.warn(`[VOICE] STT bridge ${bridge.name} unavailable: ${normalized.message}`);
      return null;
    }
  };

  let mlxError: Error | null = null;

  const transcribeWithMlxWhisper = (): any | null => {
    const bridgeScript = pathResolver.rootResolve(
      'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py'
    );
    const payload = JSON.stringify({
      action: 'transcribe',
      params: {
        audio_path: effectiveAudioPath,
        ...(input.language ? { language: input.language } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    });
    const commandResult = safeExecResult(resolvePythonBin('mlx_whisper'), [bridgeScript], {
      input: payload,
      env: { KYBERION_PROJECT_ROOT: pathResolver.rootResolve('.') },
    });
    if (commandResult.error || commandResult.status !== 0) {
      mlxError = new Error(
        `mlx_audio_stt_bridge failed: ${commandResult.stderr || commandResult.error?.message}`
      );
      return null;
    }

    let parsed: ReturnType<typeof parseVoiceSttBridgeResponse>;
    try {
      parsed = parseVoiceSttBridgeResponse(
        parseSafeJsonInput(commandResult.stdout, 'mlx_audio_stt_bridge response')
      );
    } catch {
      mlxError = new Error(`mlx_audio_stt_bridge returned non-JSON: ${commandResult.stdout}`);
      return null;
    }
    if (!parsed || parsed.status !== 'success') {
      mlxError = new Error(`mlx_audio_stt_bridge error: ${parsed?.error || 'invalid response'}`);
      return null;
    }
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const result = normalizeSpeechToTextResult(
      { name: 'mlx-whisper', capabilities: parsed.capabilities },
      {
        text: parsed.text,
        language: parsed.language,
        backend: 'mlx-whisper',
        capabilities: parsed.capabilities || {
          timestamps: segments.length > 0,
          granularity: segments.length > 0 ? 'segment' : 'none',
        },
        segments,
      }
    );
    const candidate = {
      status: 'succeeded',
      action: 'transcribe_voice_sample',
      audio_path: audioPath,
      model: parsed.model,
      ...result,
      priority: 100,
    };
    candidates.push(candidate);
    return candidate;
  };

  const usableBridges = bridges.filter((bridge) => bridge.name !== 'stub' || input.allow_synthetic);
  const timestampBridges = usableBridges.filter(
    (bridge) => getSpeechToTextCapabilities(bridge).timestamps
  );
  const textBridges = usableBridges.filter(
    (bridge) => !getSpeechToTextCapabilities(bridge).timestamps
  );

  const purpose = String(input.purpose || '').trim();
  // Governed order (backend 'auto' only) when a purpose is given or an
  // operator rule matches this request: prefer_timestamps becomes a hard
  // requirement, the seam policy / rules rank the eligible bridges, and the
  // direct mlx path stays the non-seam last resort — as in the default path.
  // Rules that do not match keep today's priority order exactly.
  const sttLanguage = String(input.language || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/u)[0];
  let purposeOrder: any[] | null = null;
  let selectionError: Error | null = null;
  if (
    backendPreference === 'auto' &&
    (purpose ||
      matchSeamSelectionRule(SPEECH_TO_TEXT_SEAM, {
        context: sttLanguage ? { language: sttLanguage } : {},
      }))
  ) {
    try {
      purposeOrder = selectSpeechToTextBridges({
        purpose,
        bridges,
        requires: {
          ...(preferTimestamps ? { timestamps: 'segment' as const } : {}),
          allowSynthetic: Boolean(input.allow_synthetic),
          ...(input.language ? { language: input.language } : {}),
        },
      }).bridges;
    } catch (error) {
      if (!(error instanceof SpeechToTextSelectionError)) throw error;
      selectionError = error;
      purposeOrder = [];
    }
  }

  if (purposeOrder) {
    for (const bridge of purposeOrder) {
      const result = await transcribeWithBridge(bridge);
      if (result && (!preferTimestamps || result.capabilities?.timestamps)) break;
    }
    if (
      preferTimestamps
        ? !candidates.some((candidate) => candidate.capabilities?.timestamps)
        : candidates.length === 0
    ) {
      transcribeWithMlxWhisper();
    }
    if (selectionError && candidates.length === 0) {
      throw new Error(
        `[VOICE] no usable STT backend: ${selectionError.message}` +
          (mlxError ? `; ${(mlxError as Error).message}` : '')
      );
    }
  } else if (backendPreference === 'mlx_whisper') {
    transcribeWithMlxWhisper();
  } else if (backendPreference === 'fluid_audio') {
    const bridge = usableBridges.find((candidate) => candidate.name === 'fluid-audio-parakeet');
    if (!bridge) {
      throw new Error(
        'FluidAudio/Parakeet bridge is not installed; set KYBERION_FLUID_AUDIO_STT_COMMAND.'
      );
    }
    await transcribeWithBridge(bridge);
  } else if (backendPreference === 'bridge') {
    for (const bridge of [...timestampBridges, ...textBridges]) {
      await transcribeWithBridge(bridge);
    }
  } else if (preferTimestamps) {
    for (const bridge of timestampBridges) {
      const result = await transcribeWithBridge(bridge);
      if (result?.capabilities?.timestamps) break;
    }
    if (!candidates.some((candidate) => candidate.capabilities?.timestamps)) {
      transcribeWithMlxWhisper();
    }
    if (!candidates.some((candidate) => candidate.capabilities?.timestamps)) {
      for (const bridge of textBridges) {
        if (await transcribeWithBridge(bridge)) break;
      }
    }
  } else {
    for (const bridge of textBridges) {
      if (await transcribeWithBridge(bridge)) break;
    }
    if (candidates.length === 0) transcribeWithMlxWhisper();
  }

  const selected = candidates.sort((left, right) => {
    const leftTimestamped = left.capabilities?.timestamps ? 1 : 0;
    const rightTimestamped = right.capabilities?.timestamps ? 1 : 0;
    return (
      rightTimestamped - leftTimestamped || Number(right.priority || 0) - Number(left.priority || 0)
    );
  })[0];
  if (!selected) {
    throw new Error(
      `[VOICE] no usable STT backend: ${errors[0]?.message || mlxError?.message || 'unknown error'}`
    );
  }

  logger.info(
    `[VOICE] STT確認完了: backend=${selected.backend}, ` +
      `timestamps=${Boolean(selected.capabilities?.timestamps)}, ` +
      `granularity=${selected.capabilities?.granularity || 'none'}`
  );

  if (input.write_sidecar !== false) {
    const digest = createHash('sha256').update(audioPath).digest('hex').slice(0, 20);
    const adjacentSidecar = `${audioPath}.transcript.txt`;
    const sidecarPath = (() => {
      try {
        return resolveVoicePath(adjacentSidecar, 'transcript-output');
      } catch {
        return pathResolver.sharedTmp(`stt-sidecars/${digest}.transcript.txt`);
      }
    })();
    const sidecarDir = path.dirname(sidecarPath);
    safeMkdir(sidecarDir, { recursive: true });
    safeWriteFile(sidecarPath, selected.transcript);
    logger.info(`[VOICE] transcript written to ${sidecarPath}`);
  }

  return {
    ...selected,
    selected_backend: selected.backend,
    selected_capabilities: selected.capabilities,
  };
}
