import * as path from 'node:path';
import type { AudioChunk } from './meeting-session-types.js';
import { pathResolver } from './path-resolver.js';
import { createVirtualAudioInputRecordingBridge } from './virtual-audio-input-recording-bridge.js';
import { createVirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';
import { safeExec, safeMkdir, safeWriteFile } from './secure-io.js';

export interface RecordVoiceSampleRequest {
  action: 'record_voice_sample';
  request_id: string;
  sample_id: string;
  duration_sec: number;
  language?: string;
  prompt_text?: string;
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
  reason?: string;
}

function getRecordingCommand(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KYBERION_AUDIO_RECORD_COMMAND || '').trim();
}

function resolveOutputPath(input: RecordVoiceSampleRequest): string {
  if (String(input.output_path || '').trim()) {
    return pathResolver.rootResolve(String(input.output_path).trim());
  }
  return pathResolver.sharedTmp(`voice-sample-recording/${input.request_id}/${input.sample_id}.wav`);
}

function resolvePromptPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.prompt.txt`);
}

function writeWavFromAudioChunks(outputPath: string, chunks: AudioChunk[]): void {
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

    const selectedInput = String(input.input_device_preference || '').trim() || probe.inputs[0] || '';
    const chunks: AudioChunk[] = [];
    for await (const chunk of bridge.captureStream(selectedInput || undefined, {
      duration_sec: durationSec,
      prompt_text: promptText || undefined,
    })) {
      chunks.push(chunk);
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

    writeWavFromAudioChunks(outputPath, chunks);

    return {
      status: 'succeeded',
      action: 'record_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      output_path: outputPath,
      ...(promptPath ? { prompt_path: promptPath } : {}),
      duration_sec: durationSec,
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
