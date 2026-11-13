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
    const page = read('presence/displays/concierge/src/app/ops/page.tsx');
    // SX: page.tsx was split into a shell plus a static quick-action config
    // module; each label/route is asserted against the file that owns it.
    const shell = read('presence/displays/concierge/src/app/ops/ChronosMirrorShell.tsx');
    const pageConfig = read('presence/displays/concierge/src/app/ops/chronos-page-config.ts');

    // MSN-SHELL-IA: first-run guidance moved from /ops to the home setup
    // checklist (one place per concern); /ops keeps the identity badge via its shell.
    // The unused FirstRunBanner component was removed with that move.
    const home = read('presence/displays/concierge/src/app/page.tsx');
    expect(page).not.toContain('FirstRunBanner');
    expect(home).toMatch(/SetupChecklist|setup-checklist/);
    expect(shell).toContain('IdentityBadge');
    // UX-03: the label moved into the vocabulary catalog; the shell renders it via its key.
    expect(shell).toContain("uxText('chronos_agent_runtimes'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_prereq_check'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_setup_report'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_schedule_tick'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_schedule_list'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_vital_check'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_build_test'");
    expect(pageConfig).toContain('chronos://quick-action/prereq-check');
    expect(pageConfig).toContain('chronos://quick-action/setup-report');
    expect(pageConfig).toContain('chronos://quick-action/schedule-tick');
    expect(pageConfig).toContain('chronos://quick-action/schedule-list');
    expect(pageConfig).toContain('chronos://quick-action/vital-check');
    // UI-07 wave 3b: the quick-action names live in the vocabulary catalog.
    const vocabulary = read('knowledge/product/orchestration/user-facing-vocabulary.json');
    expect(vocabulary).toContain('Run Prereq Check and Setup Report');
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
    // FD-08: /work dropped the first-run banner (superseded by the home
    // page's own first-run guidance) — identity-badge stays.
    expect(presenceStudio).not.toContain('first-run-banner');
    expect(presenceStudio).toContain('identity-badge');
  });
});
