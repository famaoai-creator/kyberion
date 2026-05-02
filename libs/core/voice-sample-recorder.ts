import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExec, safeMkdir, safeWriteFile } from './secure-io.js';

export interface RecordVoiceSampleRequest {
  action: 'record_voice_sample';
  request_id: string;
  sample_id: string;
  duration_sec: number;
  language?: string;
  prompt_text?: string;
  output_path?: string;
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

export function recordVoiceSample(
  input: RecordVoiceSampleRequest,
  env: NodeJS.ProcessEnv = process.env,
): RecordVoiceSampleResult {
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
