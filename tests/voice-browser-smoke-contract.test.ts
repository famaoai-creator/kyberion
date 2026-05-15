import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

describe('voice and browser smoke contract', () => {
  it('keeps the presence-studio voice surface wired to the current voice runtime endpoints', () => {
    const server = read('presence/displays/presence-studio/server.ts');
    const page = read('presence/displays/presence-studio/static/index.html');
    const pipeline = read('pipelines/voice-hello.json');

    expect(server).toContain("/health");
    expect(server).toContain("/api/voice/native-listen");
    expect(server).toContain("/api/voice/input-devices");
    expect(server).toContain("/api/voice/stt-backends");
    expect(server).toContain("/api/voice/speech-state");
    expect(server).toContain("/api/voice/stop-speaking");

    expect(page).toContain('Hold To Talk');
    expect(page).toContain('Start Native Mic');
    expect(page).toContain('Start Browser Mic');
    expect(page).toContain('Voice state: idle');
    expect(page).toContain('voice-hub');

    expect(pipeline).toContain('system:check_native_tts');
    expect(pipeline).toContain('system:native_tts_speak');
    expect(pipeline).toContain('voice-hello.user-spoke');
    expect(pipeline).toContain('wait_for');
  });

  it('keeps the browser and voice smoke pipelines pointed at the current health checks', () => {
    const browserCatalog = read('libs/actuators/browser-actuator/examples/catalog.json');
    const voiceHealth = read('pipelines/voice-health-check.json');
    const packageJson = read('package.json');
    const smokePipeline = read('pipelines/ui-voice-browser-smoke.json');

    expect(browserCatalog).toContain('test-session-recording');
    expect(browserCatalog).toContain('Playwright trace and video recording');
    expect(browserCatalog).toContain('operator-pause-template');

    expect(voiceHealth).toContain('mlx_audio_tts_bridge.py');
    expect(voiceHealth).toContain('system:system_notify');
    expect(voiceHealth).toContain('Voice Health Check');

    expect(packageJson).toContain('test:ui-voice-browser-smoke');
    expect(packageJson).toContain('tests/voice-browser-smoke-contract.test.ts');
    expect(packageJson).toContain('libs/actuators/meeting-actuator/src/index.test.ts');

    expect(smokePipeline).toContain('presence/displays/presence-studio/server.ts');
    expect(smokePipeline).toContain('pipelines/voice-hello.json');
    expect(smokePipeline).toContain('pipelines/verify-session.json');
    expect(smokePipeline).toContain('libs/actuators/meeting-actuator/src/index.ts');
    expect(smokePipeline).toContain('meeting consent gate');
  });
});
