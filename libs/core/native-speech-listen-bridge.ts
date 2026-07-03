/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import { pathResolver } from './path-resolver.js';

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

export async function listenNativeSpeech(
  request: NativeSpeechListenRequest
): Promise<NativeSpeechListenResult> {
  const scriptPath =
    request.scriptPath?.trim() || pathResolver.resolve('satellites/voice-hub/native-stt.swift');

  return new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      '--locale',
      request.locale,
      '--timeout',
      String(request.timeoutSeconds),
    ];
    if (request.deviceId) {
      args.push('--device-id', request.deviceId);
    }

    const child = spawn('swift', args, {
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
        const parsed = JSON.parse(raw) as NativeSpeechListenResult;
        resolve({
          ok: Boolean(parsed.ok),
          text: parsed.text,
          error: parsed.error,
          isFinal: parsed.isFinal,
          locale: parsed.locale || request.locale,
          deviceId: parsed.deviceId ?? request.deviceId,
        });
      } catch (error: any) {
        reject(new Error(`native_speech_invalid_json: ${error?.message || error}: ${raw}`));
      }
    });
  });
}
