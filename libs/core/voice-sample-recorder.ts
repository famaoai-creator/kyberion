import * as path from 'node:path';
import type { AudioChunk } from './meeting-session-types.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import { createVirtualAudioInputRecordingBridge } from './virtual-audio-input-recording-bridge.js';
import { createVirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';
import { safeExec, safeMkdir, safeWriteFile } from './secure-io.js';
import { resolveVoicePath } from './voice-path-policy.js';

export interface RecordVoiceSampleRequest {
  action: 'record_voice_sample';
  request_id: string;
  sample_id: string;
  duration_sec: number;
  language?: string;
  prompt_text?: string;
  recording_countdown_sec?: number;
  prompt_display_hold_ms?: number;
  output_path?: string;
  input_device_preference?: string;
}

export interface RecordVoiceSampleResult {
  status: 'succeeded' | 'blocked';
  action: 'record_voice_sample';
  request_id: string;
  sample_id: string;
  output_path?: string;
  prompt_path?: string;
  duration_sec: number;
  backend?: string;
  selected_input_device?: string;
  captured_duration_sec?: number;
  peak_dbfs?: number;
  quality?: 'good' | 'too_short' | 'silent';
  reason?: string;
}

interface AudioCaptureMetrics {
  duration_sec: number;
  peak_dbfs: number;
  rms_dbfs: number;
}

function getRecordingCommand(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KYBERION_AUDIO_RECORD_COMMAND || '').trim();
}

function resolveOutputPath(input: RecordVoiceSampleRequest): string {
  if (String(input.output_path || '').trim()) {
    return resolveVoicePath(String(input.output_path).trim(), 'recording-output');
  }
  return pathResolver.sharedTmp(`voice-sample-recording/${input.request_id}/${input.sample_id}.wav`);
}

function resolvePromptPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.prompt.txt`);
}

function analyzeAudioChunks(chunks: AudioChunk[]): AudioCaptureMetrics {
  const format = chunks[0].format;
  const bytesPerSecond = format.sample_rate_hz * format.channels * 2;
  let totalBytes = 0;
  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;

  for (const chunk of chunks) {
    const data = Buffer.from(chunk.payload);
    totalBytes += data.byteLength;
    for (let offset = 0; offset + 1 < data.length; offset += 2) {
      const amplitude = Math.abs(data.readInt16LE(offset)) / 32768;
      peak = Math.max(peak, amplitude);
      sumSquares += amplitude * amplitude;
      sampleCount += 1;
    }
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const toDbfs = (value: number) => (value > 0 ? 20 * Math.log10(value) : -Infinity);
  return {
    duration_sec: bytesPerSecond > 0 ? totalBytes / bytesPerSecond : 0,
    peak_dbfs: toDbfs(peak),
    rms_dbfs: toDbfs(rms),
  };
}

function writeWavFromAudioChunks(outputPath: string, chunks: AudioChunk[]): AudioCaptureMetrics {
  if (chunks.length === 0) {
    throw new Error('record_voice_sample captured no audio chunks');
  }
  const format = chunks[0].format;
  if (format.encoding !== 'pcm_s16le') {
    throw new Error(`record_voice_sample only supports pcm_s16le capture, got ${format.encoding}`);
  }
  const dataSize = chunks.reduce((total, chunk) => total + chunk.payload.byteLength, 0);
  const buffer = Buffer.alloc(44 + dataSize);
  const writeString = (offset: number, value: string) => buffer.write(value, offset, 'ascii');
  const writeUInt32LE = (offset: number, value: number) => buffer.writeUInt32LE(value, offset);
  const writeUInt16LE = (offset: number, value: number) => buffer.writeUInt16LE(value, offset);
  const channels = format.channels;
  const sampleRate = format.sample_rate_hz;
  const bitsPerSample = 16;

  writeString(0, 'RIFF');
  writeUInt32LE(4, 36 + dataSize);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  writeUInt32LE(16, 16);
  writeUInt16LE(20, 1);
  writeUInt16LE(22, channels);
  writeUInt32LE(24, sampleRate);
  writeUInt32LE(28, sampleRate * channels * (bitsPerSample / 8));
  writeUInt16LE(32, channels * (bitsPerSample / 8));
  writeUInt16LE(34, bitsPerSample);
  writeString(36, 'data');
  writeUInt32LE(40, dataSize);

  let offset = 44;
  for (const chunk of chunks) {
    const data = Buffer.from(chunk.payload);
    data.copy(buffer, offset);
    offset += data.byteLength;
  }
  safeWriteFile(outputPath, buffer);
  return analyzeAudioChunks(chunks);
}

function renderProgress(elapsedSec: number, durationSec: number): string {
  const width = 28;
  const ratio = Math.min(1, Math.max(0, elapsedSec / Math.max(durationSec, 0.1)));
  const filled = Math.round(width * ratio);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${elapsedSec.toFixed(1)}/${durationSec.toFixed(1)}s`;
}

async function prepareRecording(promptText: string, countdownSec: number, displayHoldMs: number): Promise<void> {
  if (!promptText) return;
  logger.info(`[VOICE] 📖 読み上げる文章:\n「${promptText}」`);
  if (displayHoldMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, displayHoldMs));
  }
  const seconds = Math.max(0, Math.floor(countdownSec));
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    logger.info(`[VOICE] 🎙️ マイク ON まで ${remaining} 秒...`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
    logger.info(`[VOICE] 🔴 録音開始。次の文章をそのまま読み上げてください:\n「${promptText}」`);
}

function interpolateCommand(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'gu'), value);
  }
  return result;
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/gu, '\\$1')}"`;
}

export async function recordVoiceSample(
  input: RecordVoiceSampleRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecordVoiceSampleResult> {
  const requestId = String(input.request_id || '').trim();
  const sampleId = String(input.sample_id || '').trim();
  const durationSec = Number(input.duration_sec);
  if (!requestId) throw new Error('record_voice_sample requires request_id');
  if (!sampleId) throw new Error('record_voice_sample requires sample_id');
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('record_voice_sample requires positive duration_sec');
  }

  const outputPath = resolveOutputPath(input);
  const outputDir = path.dirname(outputPath);
  safeMkdir(outputDir, { recursive: true });

  const promptText = String(input.prompt_text || '').trim();
  const countdownSec = Number.isFinite(Number(input.recording_countdown_sec))
    ? Number(input.recording_countdown_sec)
    : 3;
  const promptDisplayHoldMs = Math.max(0, Number(input.prompt_display_hold_ms) || 0);
  const promptPath = promptText ? resolvePromptPath(outputPath) : undefined;
  if (promptPath) {
    safeWriteFile(promptPath, `${promptText}\n`);
  }

  const commandTemplate = getRecordingCommand(env);
  if (!commandTemplate && process.platform === 'darwin') {
    const bridge = createVirtualAudioInputRecordingBridge({
      inventory_bridge: createVirtualDeviceInventoryBridge(),
    });
    const probe = await bridge.probe();
    if (!probe.available) {
      return {
        status: 'blocked',
        action: 'record_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        output_path: outputPath,
        ...(promptPath ? { prompt_path: promptPath } : {}),
        duration_sec: durationSec,
        reason: probe.reason || 'no audio inputs found',
      };
    }

    await prepareRecording(promptText, countdownSec, promptDisplayHoldMs);
    const selectedInput = String(input.input_device_preference || '').trim() || probe.inputs[0] || '';
    const chunks: AudioChunk[] = [];
    let capturedBytes = 0;
    let lastProgressSecond = -1;
    for await (const chunk of bridge.captureStream(selectedInput || undefined, {
      duration_sec: durationSec,
      prompt_text: promptText || undefined,
    })) {
      chunks.push(chunk);
      capturedBytes += chunk.payload.byteLength;
      const capturedSec = capturedBytes / (chunk.format.sample_rate_hz * chunk.format.channels * 2);
      const progressSecond = Math.floor(capturedSec);
      if (progressSecond > lastProgressSecond) {
        lastProgressSecond = progressSecond;
        logger.info(`[VOICE] ${renderProgress(capturedSec, durationSec)}`);
      }
    }
    if (chunks.length === 0) {
      return {
        status: 'blocked',
        action: 'record_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        output_path: outputPath,
        ...(promptPath ? { prompt_path: promptPath } : {}),
        duration_sec: durationSec,
        reason: 'failed to record from selected audio input',
        selected_input_device: selectedInput || undefined,
      };
    }

    const metrics = writeWavFromAudioChunks(outputPath, chunks);
    const minDurationSec = Math.max(1, durationSec * 0.75);
    if (metrics.duration_sec < minDurationSec) {
      return {
        status: 'blocked',
        action: 'record_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        output_path: outputPath,
        ...(promptPath ? { prompt_path: promptPath } : {}),
        duration_sec: durationSec,
        captured_duration_sec: metrics.duration_sec,
        peak_dbfs: metrics.peak_dbfs,
        quality: 'too_short',
        selected_input_device: selectedInput || undefined,
        reason: `recording was too short (${metrics.duration_sec.toFixed(1)}s of ${durationSec.toFixed(1)}s)`,
      };
    }
    if (metrics.rms_dbfs < -60) {
      return {
        status: 'blocked',
        action: 'record_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        output_path: outputPath,
        ...(promptPath ? { prompt_path: promptPath } : {}),
        duration_sec: durationSec,
        captured_duration_sec: metrics.duration_sec,
        peak_dbfs: metrics.peak_dbfs,
        quality: 'silent',
        selected_input_device: selectedInput || undefined,
        reason: `recording level is too low (RMS ${metrics.rms_dbfs.toFixed(1)} dBFS)`,
      };
    }
    logger.info(`[VOICE] ✅ 録音完了 ${renderProgress(metrics.duration_sec, durationSec)} / peak ${metrics.peak_dbfs.toFixed(1)} dBFS`);

    return {
      status: 'succeeded',
      action: 'record_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      output_path: outputPath,
      ...(promptPath ? { prompt_path: promptPath } : {}),
      duration_sec: durationSec,
      captured_duration_sec: metrics.duration_sec,
      peak_dbfs: metrics.peak_dbfs,
      quality: 'good',
      backend: 'ffmpeg-avfoundation-stream',
      selected_input_device: selectedInput,
    };
  }

  if (!commandTemplate) {
    return {
      status: 'blocked',
      action: 'record_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      output_path: outputPath,
      ...(promptPath ? { prompt_path: promptPath } : {}),
      duration_sec: durationSec,
      reason: 'KYBERION_AUDIO_RECORD_COMMAND is not configured',
    };
  }

  const shell = env.SHELL || '/bin/zsh';
  const command = interpolateCommand(commandTemplate, {
    output: shellQuote(outputPath),
    duration_sec: String(durationSec),
    language: shellQuote(String(input.language || '')),
    prompt_path: shellQuote(promptPath || ''),
    prompt_hold_ms: String(promptDisplayHoldMs),
    sample_id: shellQuote(sampleId),
    request_id: shellQuote(requestId),
  });
  safeExec(shell, ['-lc', command], {
    timeoutMs: Math.max(30_000, durationSec * 1000 + 15_000),
  });

  return {
    status: 'succeeded',
    action: 'record_voice_sample',
    request_id: requestId,
    sample_id: sampleId,
    output_path: outputPath,
    ...(promptPath ? { prompt_path: promptPath } : {}),
    duration_sec: durationSec,
    backend: 'shell-command',
  };
}
