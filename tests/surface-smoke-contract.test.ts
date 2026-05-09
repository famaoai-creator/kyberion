import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

describe('surface smoke contract', () => {
  it('keeps the Chronos first-run surface and operator controls in place', () => {
    const page = read('presence/displays/chronos-mirror-v2/src/app/page.tsx');
    const banner = read('presence/displays/chronos-mirror-v2/src/components/FirstRunBanner.tsx');

    expect(page).toContain('FirstRunBanner');
    expect(page).toContain('IdentityBadge');
    expect(page).toContain('Agent Runtimes');
    expect(page).toContain('Prereq Check');
    expect(page).toContain('Setup Report');
    expect(page).toContain('Schedule Tick');
    expect(page).toContain('Schedule List');
    expect(page).toContain('Vital Check');
    expect(page).toContain('Build & Test');
    expect(page).toContain('chronos://quick-action/prereq-check');
    expect(page).toContain('chronos://quick-action/setup-report');
    expect(page).toContain('chronos://quick-action/schedule-tick');
    expect(page).toContain('chronos://quick-action/schedule-list');
    expect(page).toContain('chronos://quick-action/vital-check');
    expect(banner).toContain('First Run');
    expect(banner).toContain('Open');
    expect(banner).toContain('Prereq Check');
    expect(banner).toContain('Setup Report');
    expect(banner).toContain('Vital Check');
  });

  it('keeps the browser recording example catalog and voice first-win pipeline in place', () => {
    const browserCatalog = read('libs/actuators/browser-actuator/examples/catalog.json');
    const voicePipeline = read('pipelines/voice-hello.json');

    expect(browserCatalog).toContain('test-session-recording');
    expect(browserCatalog).toContain('Playwright trace and video recording');
    expect(voicePipeline).toContain('"pipeline_id": "voice-hello"');
    expect(voicePipeline).toContain('system:native_tts_speak');
    expect(voicePipeline).toContain('http://127.0.0.1:3031/voice-hello');
  });

  it('keeps the operator-facing computer and presence surfaces visibly ready', () => {
    const computerSurface = read('presence/displays/computer-surface/static/index.html');
    const presenceStudio = read('presence/displays/presence-studio/static/index.html');

    expect(computerSurface).toContain('Computer Surface');
    expect(computerSurface).toContain('first-run-banner');
    expect(computerSurface).toContain('identity-badge');
    expect(presenceStudio).toContain('Presence Studio');
    expect(presenceStudio).toContain('first-run-banner');
    expect(presenceStudio).toContain('identity-badge');
  });
});
