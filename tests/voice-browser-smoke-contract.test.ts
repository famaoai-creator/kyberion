import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

function readJson(relativePath: string): { steps?: Array<{ op?: string; consumes?: string }> } {
  return JSON.parse(read(relativePath)) as { steps?: Array<{ op?: string; consumes?: string }> };
}

describe('voice and browser smoke contract', () => {
  it('keeps the presence-studio voice surface wired to the current voice runtime endpoints', () => {
    const server = read('presence/displays/presence-studio/server.ts');
    const page = read('presence/displays/presence-studio/static/index.html');
    const pipeline = readJson('pipelines/voice-hello.json');

    expect(server).toContain('/health');
    expect(server).toContain('/api/voice/native-listen');
    expect(server).toContain('/api/voice/input-devices');
    expect(server).toContain('/api/voice/stt-backends');
    expect(server).toContain('/api/voice/speech-state');
    expect(server).toContain('/api/voice/stop-speaking');
    expect(server).toContain('/api/voice/minutes');
    expect(server).toContain('/api/email-triage');
    expect(server).toContain('/api/email-draft');
    expect(server).toContain('/api/email-auth-status');
    expect(server).toContain('/api/email-deliver');

    expect(page).toContain('Hold To Talk');
    expect(page).toContain('Start Native Mic');
    expect(page).toContain('Start Browser Mic');
    expect(page).toContain('Notes Capture');
    expect(page).toContain('setText("#minutes-save", "create_minutes"');
    expect(page).toContain('Email Triage');
    expect(page).toContain('Refresh Triage');
    expect(page).toContain('Copy Draft');
    expect(page).toContain('Email Reply Draft');
    expect(page).toContain('email account status');
    expect(page).toContain('Create Reply Draft');
    expect(page).toContain('Create Account Draft');
    expect(page).toContain('Send Approved Email');
    expect(page).toContain('Confirm email send');
    expect(page).toContain('Send Email');
    expect(page).toContain(
      'This send will be recorded in the selected email account and the local Presence Studio event flow.'
    );
    expect(page).toContain('click outside the dialog to cancel.');
    expect(page).toContain('Refresh Auth');
    expect(page).toContain('Reload Draft');
    expect(page).toContain('Copy Reply');
    expect(page).toContain('I approve sending this email');
    expect(page).toContain('Kyberion Design System');
    expect(page).toContain('design-system.css');
    expect(page).toContain('Voice state: idle');
    expect(page).toContain('voice-hub');

    expect(pipeline.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'system:check_native_tts' }),
        expect.objectContaining({ op: 'system:native_tts_speak', consumes: 'tts_ready' }),
      ])
    );
    expect(pipeline.steps?.some((step) => step.op === 'system:wait_for')).toBe(false);
  });

  it('keeps the browser and voice smoke pipelines pointed at the current health checks', () => {
    const browserCatalog = read('libs/actuators/browser-actuator/examples/catalog.json');
    const voiceHealth = read('pipelines/voice-health-check.json');
    const packageJson = read('package.json');
    const testSuite = read('scripts/test_suite.ts');
    const smokePipeline = read('pipelines/ui-voice-browser-smoke.json');

    expect(browserCatalog).toContain('test-session-recording');
    expect(browserCatalog).toContain('Playwright trace and video recording');
    expect(browserCatalog).toContain('operator-pause-template');

    expect(voiceHealth).toContain('mlx_audio_tts_bridge.py');
    expect(voiceHealth).toContain('list_tool_runtimes');
    expect(voiceHealth).toContain('system:system_notify');
    expect(voiceHealth).toContain('Voice Health Check');

    expect(packageJson).toContain('scripts/test_suite.ts');
    expect(testSuite).toContain("'ui-voice-browser-smoke'");
    expect(testSuite).toContain('tests/voice-browser-smoke-contract.test.ts');
    expect(testSuite).toContain('libs/actuators/meeting-actuator/src/index.test.ts');

    expect(smokePipeline).toContain('presence/displays/presence-studio/server.ts');
    // SX-11: the smoke pipeline dropped the `system:exec node dist/...` wrappers
    // for typed ops and `core:include` fragments; the contract is that it still
    // drives the same surface, voice, session and meeting-consent checks.
    const smokeSteps = (
      JSON.parse(smokePipeline) as { steps: Array<{ op?: string; params?: { fragment?: string } }> }
    ).steps;
    expect(smokeSteps.some((step) => step.op === 'process:spawn')).toBe(true);
    expect(
      smokeSteps.some(
        (step) =>
          step.op === 'core:include' && step.params?.fragment === 'pipelines/voice-hello.json'
      )
    ).toBe(true);
    expect(
      smokeSteps.some(
        (step) =>
          step.op === 'core:include' && step.params?.fragment === 'pipelines/verify-session.json'
      )
    ).toBe(true);
    expect(smokeSteps.some((step) => step.op === 'meeting:check_consent')).toBe(true);
    expect(smokePipeline).toContain('meeting consent gate');
  });
});
