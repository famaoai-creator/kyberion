import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();

const allowedRuntimeChildProcessConsumers = [
  'libs/actuators/media-actuator/src/index.test.ts',
  'libs/actuators/video-composition-actuator/src/video-composition-action-helpers.ts',
  'libs/core/mesh/acp-mediator.ts',
  'libs/core/actuator/actuator-serve-client.ts',
  'libs/core/agent/agent-adapter.test.ts',
  'libs/core/agent/agent-adapter.ts',
  'libs/core/agent/agent-codex-app-server-adapter.ts',
  'libs/core/agent/agent-lifecycle.ts',
  'libs/core/provider/agy-cli-backend.ts',
  'libs/core/provider/agy-sdk-adapter.ts',
  'libs/core/voice/audio-playback.ts',
  'libs/core/governance/audit-forwarder.ts',
  'libs/core/provider/claude-cli-session-adapter.ts',
  'libs/core/provider/codex-cli-query.ts',
  'libs/core/actuator/deployment-adapter.ts',
  'libs/core/actuator/deployment-adapters/mobile-beta.ts',
  'libs/core/virtual/desktop-event-feed.ts',
  'libs/core/in-room-meeting-driver.ts',
  'libs/core/in-room-minutes-recorder.ts',
  'libs/core/mic-capture.ts',
  'libs/core/integrations/email-bridge.ts',
  'libs/core/environment-capability.ts',
  'libs/core/provider/gemini-cli-backend.ts',
  'libs/core/laya-mlx-judgment-backend.ts',
  'libs/core/managed-process.ts',
  'libs/core/mlx-embedding-backend.ts',
  'libs/core/media/native-speech-listen-bridge.ts',
  'libs/core/media/native-tts.ts',
  'libs/core/programmatic-tool-calling.ts',
  'libs/core/provider/provider-discovery.ts',
  'libs/core/shell/pty-engine.ts',
  'libs/core/pulse-audio-bus.ts',
  'libs/core/python-voice-bridge.test.ts',
  'libs/core/python-voice-bridge.ts',
  'libs/core/secret/secret-bridge.ts',
  'libs/core/secret/secret-resolver.ts',
  'libs/core/secure-io.ts',
  'libs/core/shell/shell-claude-cli-backend.ts',
  'libs/core/shell/shell-grok-cli-backend.ts',
  'libs/core/provider/cursor-cli-reasoning-backend.ts',
  'libs/core/provider/cursor-cli-session-adapter.ts',
  'libs/core/provider/devin-cli-reasoning-backend.ts',
  'libs/core/opencode-cli-reasoning-backend.ts',
  'libs/core/silero-vad-bridge.ts',
  'libs/core/shell/shell-streaming-stt-bridge.ts',
  'libs/core/shell/shell-streaming-tts-bridge.ts',
  'libs/core/voice/speech-to-text-bridge.ts',
  'libs/core/pfc/PhysicalLayer.ts',
  'libs/core/streaming-voice-playback.ts',
  'libs/core/ten-vad-bridge.ts',
  'libs/core/video/video-render-backend.ts',
  'libs/core/virtual/virtual-audio-input-recording-bridge.ts',
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
  }, 30000);
});
