import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

function readJson(relativePath: string): { steps?: Array<{ op?: string; consumes?: string }> } {
  return JSON.parse(read(relativePath)) as { steps?: Array<{ op?: string; consumes?: string }> };
}

describe('surface smoke contract', () => {
  it('keeps the Chronos first-run surface and operator controls in place', () => {
    const page = read('presence/displays/chronos-mirror-v2/src/app/page.tsx');
    const banner = read('presence/displays/chronos-mirror-v2/src/components/FirstRunBanner.tsx');

    expect(page).toContain('FirstRunBanner');
    expect(page).toContain('IdentityBadge');
    // UX-03: the label moved into the vocabulary catalog; the page renders it via its key.
    expect(page).toContain("uxText('chronos_agent_runtimes'");
    expect(page).toContain("uxText('chronos_qa_action_prereq_check'");
    expect(page).toContain("uxText('chronos_qa_action_setup_report'");
    expect(page).toContain("uxText('chronos_qa_action_schedule_tick'");
    expect(page).toContain("uxText('chronos_qa_action_schedule_list'");
    expect(page).toContain("uxText('chronos_qa_action_vital_check'");
    expect(page).toContain("uxText('chronos_qa_action_build_test'");
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
    const voicePipeline = readJson('pipelines/voice-hello.json');

    expect(browserCatalog).toContain('test-session-recording');
    expect(browserCatalog).toContain('Playwright trace and video recording');
    expect(voicePipeline.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'system:check_native_tts' }),
        expect.objectContaining({ op: 'system:native_tts_speak', consumes: 'tts_ready' }),
      ])
    );
    expect(voicePipeline.steps?.some((step) => step.op === 'system:wait_for')).toBe(false);
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
