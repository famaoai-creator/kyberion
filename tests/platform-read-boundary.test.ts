import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Platform read boundary — the gate that keeps OS-specific conditionals out
 * of feature code.
 *
 * Raw `process.platform` / `os.platform()` reads may exist only inside the
 * platform layer and the files listed below:
 *
 *   - libs/core/platform.ts                 owns normalization + OS predicates
 *     + the OSDriver verbs (screen capture, speak, open, …)
 *   - libs/core/platform-facts.ts           owns the declarative facts table
 *     (exe suffixes, command names, venv layout, IPC kind, path case, …)
 *   - libs/core/platform-command-adapters.ts owns the exec-side shell/locate
 *     adapters
 *   - legacy allowlist entries              pre-existing reads, migrated
 *     incrementally; the list must only shrink
 *
 * New code must inject `platform: Platform = currentPlatform` (platform.ts)
 * or consume getPlatformFacts() — never read process.platform directly.
 * Test files are exempt: `it.skipIf(process.platform !== 'darwin')` stays
 * the endorsed way to declare platform-scoped tests.
 */
const allowedRawPlatformFiles = [
  'libs/actuators/browser-actuator/src/browser-profile-manager.ts',
  'libs/actuators/browser-actuator/src/browser-profile-providers/chrome.ts',
  'libs/actuators/calendar-actuator/src/backends/jxa-backend.ts',
  'libs/actuators/calendar-actuator/src/calendar-backend.ts',
  'libs/actuators/calendar-actuator/src/calendar-registry.ts',
  'libs/actuators/secret-actuator/src/secret-actuator-helpers.ts',
  'libs/actuators/system-actuator/src/system-display-helpers.ts',
  'libs/actuators/voice-actuator/src/index.ts',
  'libs/actuators/voice-actuator/src/voice-action-helpers.ts',
  'libs/actuators/voice-actuator/src/voice-media-output-helpers.ts',
  'libs/core/binary-availability.mjs',
  'libs/core/blackhole-audio-bus.ts',
  'libs/core/coreaudio-device-inventory.ts',
  'libs/core/coreaudio-output-bridge.ts',
  'libs/core/daemon/installed-units.ts',
  'libs/core/daemon/service-manager.ts',
  'libs/core/daemon/specs.ts',
  'libs/core/in-room-meeting-driver.ts',
  'libs/core/local-ipc.ts',
  'libs/core/macos-permission-warmup.ts',
  'libs/core/media/native-tts.ts',
  'libs/core/mic-capture.ts',
  // Platform layer: the three files that own every raw read by design.
  'libs/core/platform-command-adapters.ts',
  'libs/core/platform-facts.ts',
  'libs/core/platform.ts',
  'libs/core/private-host-cache.mjs',
  'libs/core/pulse-audio-bus.ts',
  'libs/core/service/service-runtime-registry.ts',
  'libs/core/shell/pty-engine.ts',
  'libs/core/tool/tool-runtime-registry.ts',
  'libs/core/v4l2-virtual-camera-output.ts',
  'libs/core/video/ingest/video-brief.ts',
  'libs/core/virtual/desktop-event-feed.ts',
  'libs/core/virtual/desktop-launch-adapter.ts',
  'libs/core/virtual/desktop-observation-readiness.ts',
  'libs/core/virtual/desktop-recording.ts',
  'libs/core/virtual/os-accessibility-detector.ts',
  'libs/core/virtual/os-app-adapters.ts',
  'libs/core/virtual/os-automation-platform.ts',
  'libs/core/virtual/screen-capture-bridge.ts',
  'libs/core/virtual/screen-display-inventory-bridge.ts',
  'libs/core/virtual/screen-recording-bridge.ts',
  'libs/core/virtual/virtual-audio-device-bridge.ts',
  'libs/core/virtual/virtual-audio-input-recording-bridge.ts',
  'libs/core/virtual/virtual-audio-output-playback-bridge.ts',
  'libs/core/virtual/virtual-camera-bridge.ts',
  'libs/core/virtual/virtual-camera-injection-bridge.ts',
  'libs/core/virtual/virtual-device-inventory-bridge.ts',
  'libs/core/virtual/virtual-input-device-inventory-bridge.ts',
  'libs/core/virtual/virtual-media-device-control-bridge.ts',
  'libs/core/voice/audio-bus-bridge.ts',
  'libs/core/voice/audio-playback.ts',
  'libs/core/voice/realtime-voice-conversation.ts',
  'libs/core/voice/voice-engine-registry.ts',
  'libs/core/voice/voice-sample-recorder.ts',
  'libs/core/voice/voice-selection-preferences.ts',
  'libs/core/voice/voice-speculative-policy.ts',
  'libs/core/voice/voice-stt.ts',
  'libs/core/windows-local-assist-bridge.ts',
  'libs/core/windows-native-image-generation-bridge.ts',
  'libs/core/windows-native-image-recognition-bridge.ts',
  'presence/displays/chronos-mirror-v2/next.config.mjs',
  'satellites/imessage-bridge/src/index.ts',
  'satellites/voice-hub/server.ts',
  'satellites/voice-hub/speech-synthesis-runtime.ts',
  'satellites/voice-hub/voice-stt-transcribe.ts',
  'scripts/agent_runtime_supervisor_daemon.ts',
  'scripts/app_preflight.ts',
  'scripts/capability_discovery.ts',
  'scripts/capability_discovery_entry.mjs',
  'scripts/check_chronos_dom_contrast.ts',
  'scripts/continuous_owner_platform.ts',
  'scripts/daemon_watchdog.ts',
  'scripts/dependency_resolver.ts',
  'scripts/install_chronos_launchd.ts',
  'scripts/kyberion.ts',
  'scripts/lib/cli-tty-challenge-driver.ts',
  'scripts/lib/seam-calibration/voice-tts-engine.ts',
  'scripts/meeting_preflight.ts',
  'scripts/minutes_record.ts',
  'scripts/personal-pads/actions.ts',
  'scripts/pipeline-execution-part-results.ts',
  'scripts/reconcile_resident_services.ts',
  'scripts/run_baseline_check.ts',
  'scripts/run_realtime_voice_conversation.ts',
  'scripts/screenshot-annotate/server.ts',
  'scripts/voice_setup.ts',
].sort((a, b) => a.localeCompare(b));

const scanRoots = [
  'libs',
  'scripts',
  'satellites',
  'presence',
  'tools',
  'eval',
  'migration',
  'tests',
  'plugins',
];
const codeFileRe = /\.(ts|tsx|mts|mjs|cts|cjs|js|jsx)$/;
const testFileRe = /(\.test\.|\.spec\.|__tests__|\.live\.test\.)/;
const rawPlatformReadRe = /\bprocess\.platform\b|\bos\.platform\s*\(/;

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function isSkippableDir(relPath: string): boolean {
  return (
    relPath.includes('/node_modules/') ||
    relPath.includes('/dist/') ||
    relPath.includes('/.worktrees/') ||
    relPath.includes('/retired/') ||
    relPath.includes('/.git/')
  );
}

describe('Platform read boundary', () => {
  it('keeps raw process.platform / os.platform() reads confined to the layer and the declared exception set', () => {
    const offenders: string[] = [];
    for (const root of scanRoots) {
      const abs = path.join(rootDir, root);
      for (const filePath of getAllFiles(abs)) {
        if (!codeFileRe.test(filePath) || filePath.endsWith('.d.ts')) continue;
        const relPath = normalize(path.relative(rootDir, filePath));
        if (testFileRe.test(relPath) || isSkippableDir(relPath)) continue;
        const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
        if (rawPlatformReadRe.test(content)) offenders.push(relPath);
      }
    }
    offenders.sort((a, b) => a.localeCompare(b));

    expect(offenders).toEqual(allowedRawPlatformFiles);
  });
});
