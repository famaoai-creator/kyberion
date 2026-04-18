import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  getVoiceProfileRecord,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  safeExec,
  safeMkdir,
  safeReadFile,
  VoiceGenerationRuntime,
  splitVoiceTextIntoChunks,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const voiceActionValidate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/voice-action.schema.json'));

type VoiceAction =
  | { action: 'speak_local'; params: Record<string, unknown> }
  | { action: 'list_voices'; params: Record<string, unknown> }
  | Record<string, any>;

type VoiceArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';

export async function handleSingleAction(input: VoiceAction) {
  if (input.action === 'speak_local') {
    return speakLocal(input.params || {});
  }
  if (input.action === 'list_voices') {
    return listVoices();
  }
  if (input.action === 'generate_voice') {
    return generateVoice(input);
  }
  throw new Error(`Unsupported voice action: ${String((input as any)?.action)}`);
}

export async function handleAction(input: VoiceAction) {
  validateVoiceAction(input);
  if ((input as any).action === 'pipeline') {
    const results = [];
    for (const step of (input as any).steps) {
      validateVoiceAction(step);
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return handleSingleAction(input);
}

function validateVoiceAction(input: unknown): void {
  const ok = voiceActionValidate(input);
  if (ok) return;
  const detail = (voiceActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid voice action: ${detail}`);
}

async function listVoices(): Promise<any> {
  if (process.platform === 'darwin') {
    const output = safeExec('say', ['-v', '?']);
    const voices = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const voice = line.split(/\s+/)[0];
        return { id: voice, display_name: voice, provider: 'say' };
      });
    return { status: 'succeeded', voices };
  }

  if (process.platform === 'linux') {
    return {
      status: 'succeeded',
      voices: [{ id: 'espeak-default', display_name: 'espeak default', provider: 'espeak' }],
    };
  }

  if (process.platform === 'win32') {
    return {
      status: 'succeeded',
      voices: [{ id: 'windows-default', display_name: 'Windows Speech Synthesizer', provider: 'sapi' }],
    };
  }

  return { status: 'succeeded', voices: [] };
}

async function speakLocal(params: Record<string, unknown>): Promise<any> {
  const text = String(params.text || '').trim();
  if (!text) throw new Error('speak_local requires params.text');

  const language = String(params.language || '').trim().toLowerCase() || 'en';
  const defaults = getVoiceTtsLanguageConfig(language);
  const voice = typeof params.voice === 'string' && params.voice.trim() ? params.voice.trim() : defaults.voice;
  const rate = Number.isFinite(params.rate) ? Number(params.rate) : defaults.rate;

  await performPlayback(text, { language, voice, rate });
  return {
    status: 'succeeded',
    mode: 'playback',
    engine: 'native_local',
    language,
    voice,
    rate,
  };
}

async function generateVoice(input: Record<string, any>): Promise<any> {
  const profile = getVoiceProfileRecord(input.profile_ref?.profile_id);
  const policy = getVoiceRuntimePolicy();
  const jobId = String(input.request_id || randomUUID());
  const language = String(input.rendering?.language || profile.languages[0] || 'en').toLowerCase();
  const defaults = getVoiceTtsLanguageConfig(language);
  const maxChunkChars = Number(input.rendering?.chunking?.max_chunk_chars || policy.chunking.default_max_chunk_chars);
  const crossfadeMs = Number(input.rendering?.chunking?.crossfade_ms || policy.chunking.default_crossfade_ms);
  const chunks = splitVoiceTextIntoChunks(String(input.text || ''), maxChunkChars);
  const deliveryMode = String(input.delivery?.mode || 'playback');
  const requestedFormat = String(input.delivery?.format || policy.delivery.default_format) as VoiceArtifactFormat;
  const runtime = new VoiceGenerationRuntime(policy);
  const progress_packets: any[] = [];
  runtime.subscribe((packet) => {
    progress_packets.push(packet);
  });

  runtime.enqueue({
    jobId,
    async run(api) {
      api.report({
        status: 'loading_profile',
        progress: { current: 1, total: 4, percent: 25, unit: 'steps' },
        message: `resolved profile ${profile.profile_id}`,
      });
      api.report({
        status: 'loading_model',
        progress: { current: 2, total: 4, percent: 50, unit: 'steps' },
        message: `using engine ${input.engine?.engine_id || profile.default_engine_id}`,
      });

      let artifactRefs: string[] = [];
      if (deliveryMode === 'artifact' || deliveryMode === 'artifact_and_playback') {
        const artifactRef = renderNativeArtifact(String(input.text || ''), {
          requestId: jobId,
          voice: defaults.voice,
          rate: defaults.rate,
          format: requestedFormat,
          outputPath: input.delivery?.artifact_path,
        });
        artifactRefs = [artifactRef];
      }

      api.report({
        status: 'generating',
        progress: { current: 0, total: Math.max(1, chunks.length), percent: 50, unit: 'chunks' },
        message: `chunking into ${chunks.length} segment(s) with ${crossfadeMs}ms crossfade policy`,
      });

      if (deliveryMode === 'playback' || deliveryMode === 'artifact_and_playback') {
        for (let index = 0; index < chunks.length; index += 1) {
          if (api.isCancelled()) return { artifactRefs };
          api.report({
            status: 'generating',
            progress: {
              current: index + 1,
              total: Math.max(1, chunks.length),
              percent: ((index + 1) / Math.max(1, chunks.length)) * 100,
              unit: 'chunks',
            },
            message: `rendering chunk ${index + 1}/${chunks.length}`,
            artifact_refs: artifactRefs,
          });
          await performPlayback(chunks[index], {
            language,
            voice: defaults.voice,
            rate: defaults.rate,
          });
        }
      }

      api.report({
        status: 'persisting',
        progress: { current: 4, total: 4, percent: 100, unit: 'steps' },
        message: 'voice generation runtime completed',
        artifact_refs: artifactRefs,
      });
      return { artifactRefs };
    },
  });

  const finalPacket = await waitForVoiceJob(runtime, jobId);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    request_id: jobId,
    profile_id: profile.profile_id,
    language,
    engine_id: String(input.engine?.engine_id || profile.default_engine_id),
    chunks: chunks.length,
    progress_packets,
    artifact_refs: finalPacket.artifact_refs || [],
    delivery_mode: deliveryMode,
    format: requestedFormat,
  };
}

async function performPlayback(
  text: string,
  options: { language: string; voice: string; rate: number },
): Promise<void> {
  if (process.platform === 'darwin') {
    safeExec('say', ['-v', options.voice, '-r', String(options.rate), text]);
    return;
  }
  if (process.platform === 'linux') {
    safeExec('espeak', ['-s', String(options.rate), text]);
    return;
  }
  if (process.platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    safeExec('powershell', [
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${escaped}')`,
    ]);
    return;
  }
  throw new Error(`Unsupported voice playback platform: ${process.platform}`);
}

function renderNativeArtifact(
  text: string,
  options: {
    requestId: string;
    voice: string;
    rate: number;
    format: VoiceArtifactFormat;
    outputPath?: string;
  },
): string {
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  if (process.platform === 'darwin') {
    const format = options.format === 'wav' ? 'aiff' : options.format;
    safeExec('say', ['-v', options.voice, '-r', String(options.rate), '-o', artifactPath, text]);
    return artifactPath.endsWith(`.${format}`) ? artifactPath : `${artifactPath}.${format}`;
  }

  if (process.platform === 'linux') {
    if (options.format !== 'wav') {
      throw new Error(`linux native artifact rendering supports only wav, received ${options.format}`);
    }
    safeExec('espeak', ['-s', String(options.rate), '-w', artifactPath, text]);
    return artifactPath;
  }

  throw new Error(`native artifact rendering is unsupported on ${process.platform}`);
}

function resolveArtifactPath(requestId: string, format: VoiceArtifactFormat, outputPath?: string): string {
  const requestedPath = typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) return path.resolve(process.cwd(), requestedPath);
  const safeFormat = process.platform === 'darwin' && format === 'wav' ? 'aiff' : format;
  return pathResolver.sharedTmp(`voice-generation/${requestId}.${safeFormat}`);
}

async function waitForVoiceJob(runtime: VoiceGenerationRuntime, jobId: string): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const packet = runtime.getPacket(jobId);
    if (packet && ['completed', 'failed', 'cancelled'].includes(packet.status)) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`voice job timed out: ${jobId}`);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('voice-actuator/src/index.ts')
  || process.argv[1].endsWith('voice-actuator/dist/index.js')
  || process.argv[1].endsWith('voice-actuator/src/index.js')
);

if (isMain) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
