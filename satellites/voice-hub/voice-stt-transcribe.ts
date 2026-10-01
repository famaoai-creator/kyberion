// C7: shared supervised spawn/stop (cmd/args/stop-signal preserved).
import { spawnSupervisedChild, stopSupervisedChild } from '../shared/supervise-child.js';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import {
  resolveManagedToolPythonBin,
  probeToolRuntime,
} from '@agent/core/tool/tool-runtime-registry';
import {
  resolveVoiceSttAdapter,
  type VoiceSttAdapterDescriptor,
} from '@agent/core/voice/voice-provider-adapters';
import { resolveVoiceSttServerConfig, type VoiceSttBackend } from '@agent/core/voice/voice-stt';
import { ShellSpeechToTextBridge } from '@agent/core/voice/speech-to-text-bridge';
import * as pathResolver from '@agent/core/path-resolver';
import {
  parseVoiceBridgeResponse,
  parseVoiceTranscriptionResponse,
  resolveRegularRepositoryFile,
} from './request-input.js';

function parseWhisperText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('whisper_'))
    .filter((line) => !line.startsWith('ggml_'))
    .filter((line) => !line.startsWith('system_info:'))
    .filter((line) => !line.startsWith('main: processing'))
    .join(' ')
    .trim();
}

async function transcribeWithWhisperCpp(
  inputPath: string,
  locale: string,
  adapter: ReturnType<typeof resolveVoiceSttAdapter>
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!adapter.cli_path || !adapter.model_path) {
    return { ok: false, error: 'whisper_cpp_paths_not_configured' };
  }
  const cliPath = resolveRegularRepositoryFile(
    pathResolver.resolve(adapter.cli_path),
    'Whisper CLI'
  );
  const modelPath = resolveRegularRepositoryFile(
    pathResolver.resolve(adapter.model_path),
    'Whisper model'
  );
  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  const workingDirectory = path.dirname(cliPath);
  return new Promise((resolve, reject) => {
    const lang = locale.toLowerCase().startsWith('ja') ? 'ja' : 'auto';
    // C7: shared supervised spawn (explicit whisper cwd preserved).
    const child = spawnSupervisedChild(
      cliPath,
      [
        '-m',
        modelPath,
        '-f',
        safeInputPath,
        '-l',
        lang,
        '--no-timestamps',
        '--suppress-nst',
        '-nth',
        '0.8',
        '-bs',
        '8',
      ],
      {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const text = parseWhisperText(`${stdout}\n${stderr}`);
      if (code === 0) {
        return resolve({ ok: true, text });
      }
      reject(new Error(text || stderr.trim() || stdout.trim() || `whisper_cli_failed_${code}`));
    });
  });
}

async function transcribeWithManagedPythonBridge(
  inputPath: string,
  locale: string,
  adapter: ReturnType<typeof resolveVoiceSttAdapter>
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const pythonBin = adapter.runtime_id ? resolveManagedToolPythonBin(adapter.runtime_id) : null;
  if (!pythonBin)
    return { ok: false, error: `${adapter.runtime_id || 'managed'}_runtime_not_installed` };
  if (!adapter.bridge_script) return { ok: false, error: 'managed_stt_bridge_not_configured' };
  const bridgeScript = resolveRegularRepositoryFile(
    pathResolver.rootResolve(adapter.bridge_script),
    'STT bridge script'
  );
  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  return new Promise((resolve) => {
    // C7: shared supervised spawn (cmd/args/stdio preserved; cwd+env via helper defaults).
    const child = spawnSupervisedChild(pythonBin, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      // C7: shared supervised stop (SIGTERM overflow guard preserved).
      if (stdout.length > 2_000_000) stopSupervisedChild(child, 'SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 200_000);
    });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) => {
      const lines = stdout.trim().split(/\n+/).filter(Boolean);
      let payload: ReturnType<typeof parseVoiceBridgeResponse>;
      try {
        payload = lines.length
          ? parseVoiceBridgeResponse(
              parseSafeJsonInput(lines[lines.length - 1], 'voice bridge response')
            )
          : undefined;
      } catch {
        payload = undefined;
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (code === 0 && payload?.status === 'success' && text) {
        resolve({ ok: true, text });
        return;
      }
      resolve({
        ok: false,
        error:
          (typeof payload?.error === 'string' ? payload.error : undefined) ||
          stderr.trim().slice(0, 500) ||
          `${adapter.backend}_failed_${code ?? 'unknown'}`,
      });
    });
    child.stdin.end(
      JSON.stringify({
        action: 'transcribe',
        params: {
          audio_path: safeInputPath,
          language: locale.toLowerCase().startsWith('ja') ? 'ja' : undefined,
        },
      })
    );
  });
}

async function transcribeWithOpenAiCompatibleServer(
  inputPath: string,
  locale: string
): Promise<{ ok: boolean; text?: string; error?: string; backend: string }> {
  const serverConfig = resolveVoiceSttServerConfig(process.env);
  if (!serverConfig) {
    return {
      ok: false,
      error: 'stt_server_not_configured',
      backend: 'openai_compatible_server',
    };
  }

  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  const audio = safeReadFile(safeInputPath, { encoding: null }) as Buffer;
  const audioBytes = new Uint8Array(audio);
  const form = new FormData();
  form.append('file', new Blob([audioBytes], { type: 'audio/wav' }), path.basename(safeInputPath));
  form.append('model', serverConfig.model);
  if (locale.toLowerCase().startsWith('ja')) {
    form.append('language', 'ja');
  }

  const headers: Record<string, string> = {};
  if (serverConfig.apiKey) {
    headers.Authorization = `Bearer ${serverConfig.apiKey}`;
  }

  const response = await fetch(`${serverConfig.baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `stt_server_http_${response.status}`,
      backend: serverConfig.provider,
    };
  }

  const payload = parseVoiceTranscriptionResponse(await response.json());
  if (!payload) {
    return {
      ok: false,
      error: 'stt_server_invalid_response',
      backend: serverConfig.provider,
    };
  }
  const text = payload.text.trim();
  return {
    ok: text.length > 0,
    text,
    error: text.length > 0 ? undefined : 'empty_transcript',
    backend: serverConfig.provider,
  };
}

export type SttTranscribeOutcome = { ok: boolean; text?: string; error?: string; backend?: string };

export interface SttAdapterBehavior {
  /** Availability probe for the adapter kind. */
  probe?: (adapter: VoiceSttAdapterDescriptor) => boolean;
  /** Transcribe invocation for the adapter kind. */
  transcribe?: (
    inputPath: string,
    locale: string,
    adapter: VoiceSttAdapterDescriptor,
    backend: VoiceSttBackend
  ) => Promise<SttTranscribeOutcome>;
}

export const STT_ADAPTER_BEHAVIORS: Record<string, SttAdapterBehavior> = {
  openai_compatible_server: {
    probe: () => resolveVoiceSttServerConfig(process.env) !== null,
    transcribe: (inputPath, locale) => transcribeWithOpenAiCompatibleServer(inputPath, locale),
  },
  fluid_audio_native: {
    probe: () =>
      Boolean(
        process.platform === 'darwin' &&
        getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim()
      ),
    transcribe: async (inputPath, locale) => {
      const result = await transcribeWithFluidAudio(inputPath, locale);
      return result.ok ? { ...result, backend: 'fluid_audio' } : result;
    },
  },
  faster_whisper_python: {
    probe: (adapter) =>
      Boolean(
        adapter.runtime_id &&
        process.platform === 'win32' &&
        (getRegisteredEnvText('KYBERION_WINDOWS_STT_BACKEND') === 'faster_whisper' ||
          getRegisteredEnvText('KYBERION_STT_MODEL_DIR')?.trim()) &&
        probeToolRuntime(adapter.runtime_id as string, 'installed').installed
      ),
    transcribe: async (inputPath, locale, adapter, backend) => {
      const result = await transcribeWithManagedPythonBridge(inputPath, locale, adapter);
      return result.ok ? { ...result, backend } : result;
    },
  },
  managed_python_bridge: {
    probe: (adapter) =>
      Boolean(
        adapter.runtime_id && probeToolRuntime(adapter.runtime_id as string, 'installed').installed
      ),
    transcribe: async (inputPath, locale, adapter, backend) => {
      const result = await transcribeWithManagedPythonBridge(inputPath, locale, adapter);
      return result.ok ? { ...result, backend } : result;
    },
  },
  whisper_cpp_cli: {
    probe: (adapter) =>
      Boolean(
        adapter.cli_path &&
        adapter.model_path &&
        safeExistsSync(pathResolver.resolve(adapter.cli_path)) &&
        safeExistsSync(pathResolver.resolve(adapter.model_path))
      ),
    transcribe: async (inputPath, locale, adapter) => {
      const result = await transcribeWithWhisperCpp(inputPath, locale, adapter);
      return result.ok ? { ...result, backend: 'whisper_cpp' } : result;
    },
  },
  native_speech: {
    probe: () => safeExistsSync(pathResolver.resolve('satellites/voice-hub/native-stt.swift')),
  },
};

async function transcribeWithFluidAudio(
  inputPath: string,
  locale: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const command = getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim();
  if (!command) return { ok: false, error: 'fluid_audio_command_not_configured' };

  const bridge = new ShellSpeechToTextBridge({
    name: 'fluid-audio-parakeet',
    command,
    structuredOutput: true,
    timeoutMs: Number(getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_TIMEOUT_MS')) || undefined,
  });
  const transcriptPath = `${inputPath}.transcript.txt`;
  try {
    const result = await bridge.transcribe({ audioPath: inputPath, language: locale });
    const text = result.text.trim();
    return text ? { ok: true, text } : { ok: false, error: 'empty_transcript' };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (safeExistsSync(transcriptPath)) safeRmSync(transcriptPath, { force: true });
  }
}
