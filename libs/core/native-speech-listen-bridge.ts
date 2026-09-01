/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import { pathResolver } from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';

export const NATIVE_SPEECH_LISTEN_BRIDGE_ID = 'native-speech-listen-bridge' as const;

export interface NativeSpeechListenRequest {
  locale: string;
  timeoutSeconds: number;
  deviceId?: string;
  scriptPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface NativeSpeechListenResult {
  ok: boolean;
  text?: string;
  error?: string;
  isFinal?: boolean;
  locale: string;
  deviceId?: string;
}

export function normalizeNativeSpeechListenResult(
  value: unknown,
  fallback: Pick<NativeSpeechListenRequest, 'locale'> & { deviceId?: string }
): NativeSpeechListenResult {
  if (!isRecord(value)) throw new Error('native speech result must be a JSON object');
  const ok = value.ok;
  const text = value.text;
  const error = value.error;
  const locale = value.locale;
  const deviceId = value.deviceId;
  const isFinal = value.isFinal;
  if (typeof ok !== 'boolean') throw new Error('native speech result.ok must be boolean');

  for (const key of ['text', 'error', 'locale', 'deviceId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`native speech result.${key} must be a string`);
    }
  }
  let normalizedIsFinal: boolean | undefined;
  if (isFinal !== undefined) {
    if (typeof isFinal !== 'boolean') {
      throw new Error('native speech result.isFinal must be boolean');
    }
    normalizedIsFinal = isFinal;
  }

  return {
    ok,
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    isFinal: normalizedIsFinal,
    locale: typeof locale === 'string' && locale.trim() ? locale : fallback.locale,
    deviceId: typeof deviceId === 'string' ? deviceId : (fallback.deviceId ?? undefined),
  };
}

function buildWindowsSpeechCommand(request: NativeSpeechListenRequest): {
  command: string;
  args: string[];
} {
  const locale = request.locale.replace(/'/g, "''");
  const timeout = Math.max(1, Math.round(request.timeoutSeconds));
  // System.Speech is included with Windows PowerShell/.NET Framework.  The
  // recognizer uses the user's default recording device and the installed
  // DictationGrammar for the requested locale.
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Speech',
    `$culture=New-Object System.Globalization.CultureInfo('${locale}')`,
    '$engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)',
    '$engine.SetInputToDefaultAudioDevice()',
    '$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    `$result=$engine.Recognize([TimeSpan]::FromSeconds(${timeout}))`,
    `if ($null -eq $result) { @{ok=$false;locale='${locale}';error='no_speech_result'} | ConvertTo-Json -Compress } else { @{ok=$true;locale='${locale}';isFinal=$true;text=$result.Text} | ConvertTo-Json -Compress }`,
  ].join(';');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  };
}

export async function listenNativeSpeech(
  request: NativeSpeechListenRequest
): Promise<NativeSpeechListenResult> {
  const isWindows = process.platform === 'win32';
  const scriptPath =
    request.scriptPath?.trim() || pathResolver.resolve('satellites/voice-hub/native-stt.swift');

  return new Promise((resolve, reject) => {
    const windowsCommand = isWindows ? buildWindowsSpeechCommand(request) : null;
    const command = windowsCommand?.command || 'swift';
    const args = windowsCommand?.args || [
      scriptPath,
      '--locale',
      request.locale,
      '--timeout',
      String(request.timeoutSeconds),
      ...(request.deviceId ? ['--device-id', request.deviceId] : []),
    ];

    const child = spawn(command, args, {
      cwd: request.cwd || pathResolver.rootDir(),
      env: request.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    // Node.js side safety timeout (Swift timeout + 2s padding)
    const timeoutMs = request.timeoutSeconds * 1000 + 2000;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;

      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`native_speech_timeout: Process hung and was killed after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      completed = true;
      clearTimeout(timer);
    };

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (completed) return;
      cleanup();

      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (completed) return;
      cleanup();

      const raw = stdout.trim();
      if (!raw) {
        return reject(new Error(stderr.trim() || `native_speech_failed_${code}`));
      }
      try {
        const parsed: unknown = parseSafeJsonInput(raw, 'native speech listen response');
        resolve(normalizeNativeSpeechListenResult(parsed, request));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new Error(`native_speech_invalid_json: ${detail}: ${raw}`));
      }
    });
  });
}
