import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();

const allowedRuntimeChildProcessConsumers = [
  'libs/actuators/media-actuator/src/index.test.ts',
  'libs/actuators/video-composition-actuator/src/video-composition-action-helpers.ts',
  'libs/core/acp-mediator.ts',
  'libs/core/agent-adapter.test.ts',
  'libs/core/agent-adapter.ts',
  'libs/core/agent-lifecycle.ts',
  'libs/core/agy-cli-backend.ts',
  'libs/core/audit-forwarder.ts',
  'libs/core/blackhole-audio-bus.ts',
  'libs/core/codex-cli-query.ts',
  'libs/core/deployment-adapter.ts',
  'libs/core/deployment-adapters/mobile-beta.ts',
  'libs/core/in-room-meeting-driver.ts',
  'libs/core/in-room-minutes-recorder.ts',
  'libs/core/mic-capture.ts',
  'libs/core/doctor_core.ts',
  'libs/core/email-bridge.ts',
  'libs/core/environment-capability.ts',
  'libs/core/gemini-cli-backend.ts',
  'libs/core/managed-process.ts',
  'libs/core/mlx-embedding-backend.ts',
  'libs/core/native-speech-listen-bridge.ts',
  'libs/core/native-tts.ts',
  'libs/core/orchestrator.ts',
  'libs/core/programmatic-tool-calling.ts',
  'libs/core/provider-discovery.ts',
  'libs/core/pty-engine.ts',
  'libs/core/pulse-audio-bus.ts',
  'libs/core/python-voice-bridge.test.ts',
  'libs/core/python-voice-bridge.ts',
  'libs/core/secret-bridge.ts',
  'libs/core/secret-resolver.ts',
  'libs/core/secure-io.ts',
  'libs/core/shell-claude-cli-backend.ts',
  'libs/core/shell-streaming-stt-bridge.ts',
  'libs/core/shell-streaming-tts-bridge.ts',
  'libs/core/speech-to-text-bridge.ts',
  'libs/core/src/pfc/PhysicalLayer.ts',
  'libs/core/video-render-backend.ts',
  'libs/core/virtual-audio-input-recording-bridge.ts',
  'satellites/voice-hub/server.ts',
].sort((a, b) => a.localeCompare(b));

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime child_process boundary', () => {
  it('confines direct child_process imports in production runtime code to declared boundaries', () => {
    const codeFiles = getAllFiles(rootDir).filter((filePath) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)
    );
    const actual = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.startsWith('tests/'))
      .filter((relPath) => !relPath.startsWith('dist/'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => !relPath.includes('/.next/'))
      .filter((relPath) => !relPath.startsWith('vault/'))
      .filter((relPath) => !relPath.startsWith('scripts/'))
      .filter((relPath) =>
        /\bfrom ['"]node:child_process['"]|require\(['"]node:child_process['"]\)/.test(
          read(relPath)
        )
      )
      .sort((a, b) => a.localeCompare(b));

    expect(actual).toEqual(allowedRuntimeChildProcessConsumers);
  });
});
