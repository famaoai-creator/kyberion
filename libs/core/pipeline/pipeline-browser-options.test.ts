import { describe, expect, it } from 'vitest';
import {
  browserProfilePartition,
  browserVideoPartition,
  classifyPipelineBrowserOptions,
  describeDroppedBrowserOption,
  pipelineUsesBrowser,
} from './pipeline-browser-options.js';

const ACME = { tier: 'confidential', tenant_slug: 'acme' };
const PROFILES = 'active/shared/runtime/browser/profiles/confidential/acme';

describe('classifyPipelineBrowserOptions', () => {
  it('applies only the allowlisted options, with a deep-copied navigation policy', () => {
    const authored = {
      headless: false,
      keep_alive: true,
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP',
      max_steps: 500,
      timeout_ms: 900000,
      max_inline_output_chars: 1000,
      onboarding_isolated_navigation: true,
      navigation_policy: { allow_private_network: true, allowed_origins: ['https://a.example'] },
    };
    const { applied, dropped } = classifyPipelineBrowserOptions(authored, ACME);
    expect(applied).toEqual({
      headless: false,
      keep_alive: true,
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP',
      max_steps: 500,
      timeout_ms: 900000,
      navigation_policy: { allow_private_network: true, allowed_origins: ['https://a.example'] },
    });
    // Runner options that are not browser launch options are not reported.
    expect(dropped).toEqual([]);
    (applied.navigation_policy as { allowed_origins: string[] }).allowed_origins.push('x');
    expect(authored.navigation_policy.allowed_origins).toEqual(['https://a.example']);
  });

  it('treats false / absent launch overrides as no-ops', () => {
    expect(
      classifyPipelineBrowserOptions(
        { record_video: false, record_trace: false, connect_over_cdp: false, headless: true },
        ACME
      )
    ).toEqual({ applied: { headless: true }, dropped: [] });
  });

  it.each([
    [{ connect_over_cdp: true }, 'connect_over_cdp'],
    [{ cdp_url: 'http://127.0.0.1:9222' }, 'cdp_url'],
    [{ cdp_port: 9222 }, 'cdp_port'],
    [{ launch_args: ['--host-resolver-rules=MAP * 10.0.0.1'] }, 'launch_args'],
    [{ profile: 'operator@example.com' }, 'profile'],
    [{ record_trace: true }, 'record_trace'],
    [{ browser_runtime: 'lightpanda' }, 'browser_runtime'],
  ])('drops (never applies) a launch override: %j', (options, name) => {
    const { applied, dropped } = classifyPipelineBrowserOptions(options, ACME);
    expect(applied).toEqual({});
    expect(dropped.map((entry) => entry.option)).toEqual([name]);
    expect(describeDroppedBrowserOption(dropped[0])).toMatch(
      new RegExp(`^browser options\\.${name} not applied — not available .* \\| next: remove`, 'u')
    );
  });

  it("applies a persistent profile only inside the run's own partition", () => {
    expect(browserProfilePartition(ACME)).toBe(PROFILES);
    const own = `${PROFILES}/flow`;
    expect(classifyPipelineBrowserOptions({ user_data_dir: own }, ACME).applied).toEqual({
      user_data_dir: own,
    });
    for (const user_data_dir of [
      'active/shared/runtime/browser/profiles/confidential/other/flow',
      'active/shared/runtime/browser/flow',
      'active/shared/tmp/flow-profile',
      `${PROFILES}/../other/x`,
      PROFILES,
      '/tmp/profile',
    ]) {
      const { applied, dropped } = classifyPipelineBrowserOptions({ user_data_dir }, ACME);
      expect(applied, user_data_dir).toEqual({});
      expect(describeDroppedBrowserOption(dropped[0])).toContain(
        `next: move the profile to ${PROFILES}/<profile-name>`
      );
    }
    // No location-derived scope: no profile is applied.
    expect(classifyPipelineBrowserOptions({ user_data_dir: own }, undefined).applied).toEqual({});
  });

  it('records video only into the run artifact partition', () => {
    const video = 'active/shared/artifacts/confidential/acme/browser-video/approve';
    expect(browserVideoPartition(ACME)).toBe(
      'active/shared/artifacts/confidential/acme/browser-video'
    );
    expect(
      classifyPipelineBrowserOptions({ record_video: true, video_artifact_dir: video }, ACME)
        .applied
    ).toEqual({ record_video: true, video_artifact_dir: video });
    for (const video_artifact_dir of [undefined, 'knowledge/public/videos', 'evidence/browser']) {
      const { applied, dropped } = classifyPipelineBrowserOptions(
        { record_video: true, video_artifact_dir },
        ACME
      );
      expect(applied).toEqual({});
      expect(dropped[0].option).toBe('record_video');
    }
  });

  it('accepts only a plain profile folder name', () => {
    expect(classifyPipelineBrowserOptions({ profile_directory: 'Default' }, ACME).applied).toEqual({
      profile_directory: 'Default',
    });
    expect(
      classifyPipelineBrowserOptions({ profile_directory: '../Other' }, ACME).dropped[0].option
    ).toBe('profile_directory');
  });

  it('confines an untenanted run to the shared segment of its tier', () => {
    expect(browserProfilePartition({ tier: 'public' })).toBe(
      'active/shared/runtime/browser/profiles/public/shared'
    );
  });
});

describe('pipelineUsesBrowser', () => {
  it('finds a browser op at any depth', () => {
    expect(pipelineUsesBrowser([{ op: 'system:log' }])).toBe(false);
    expect(
      pipelineUsesBrowser([
        { op: 'core:while', params: { pipeline: [{ op: 'browser:goto', params: {} }] } },
      ])
    ).toBe(true);
  });
});
