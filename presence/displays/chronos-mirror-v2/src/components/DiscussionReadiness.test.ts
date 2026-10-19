import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscussionReadinessReport } from '@agent/core/discussion/discussion-readiness';
import type { DiscussionLocale } from '../lib/discussion-client';
import type { DiscussionReadinessState } from '../lib/discussion-readiness-state';
import { DiscussionCreateUncertainty, DiscussionReadiness } from './DiscussionReadiness';

function report(): DiscussionReadinessReport {
  return {
    provider: 'codex',
    checked_at: '2026-10-18T12:00:00.000Z',
    execution: 'unverified',
    provider_calls: 0,
    checks: [
      { id: 'scope', status: 'checked', code: 'scope_checked' },
      { id: 'adapter', status: 'checked', code: 'adapter_declared' },
      { id: 'egress_policy', status: 'checked', code: 'egress_allowed' },
      { id: 'executable', status: 'checked', code: 'executable_present' },
      { id: 'artifact_destination', status: 'checked', code: 'artifact_directory_inspected' },
      { id: 'live_execution', status: 'unverified', code: 'live_execution_unverified' },
    ],
  };
}
function render(state: DiscussionReadinessState, locale: DiscussionLocale = 'en', busy = false) {
  return renderToStaticMarkup(
    createElement(DiscussionReadiness, { state, locale, busy, onRetry: () => undefined })
  );
}
function checked(value = report()): DiscussionReadinessState {
  return {
    phase: 'checked',
    selection: { provider: value.provider, missionId: '' },
    report: value,
  };
}

describe('Discussion readiness static markup (no rendered browser interaction)', () => {
  it.each(['idle', 'checking', 'failed', 'checked'] as const)(
    'always discloses zero provider calls and unverified runtime in %s',
    (phase) => {
      const html = render({ ...checked(), phase });
      expect(html).toContain('0 provider calls');
      expect(html).toContain('Goal text is not sent');
      expect(html).toContain('Browser rooms remain confidential, including pasted public text');
      expect(html).toContain(
        'Existing tenant/provider zero-retention and egress authorization are required'
      );
      expect(html).toContain(
        'Login, provider reachability, CLI version, command execution and runtime writes remain unverified'
      );
      expect(html).toContain('Checked means static inspection only');
      expect(html).not.toContain('ready to generate');
      expect(html).not.toContain('Provider response received');
    }
  );
  it.each(['idle', 'checking'] as const)('disables Retry while %s', (phase) => {
    const html = render({ phase, selection: null, report: null });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Checking existing setup');
  });
  it('shows static checks with an explicit attempt explanation, never a success claim', () => {
    const html = render(checked());
    expect(html).toContain('Live execution remains unverified');
    expect(html).toContain('Checked (static)');
    expect(html).toContain('Unverified');
    expect(html).toContain('regular file');
    expect(html).toContain('Executability and successful launch were not tested');
    expect(html).toContain('No artifact was written');
    expect(html).toContain('write success is unverified');
    expect(html).toContain('server rechecks policy before execution');
    expect(html).toContain('does not guarantee success or start a run');
    expect(html).toContain('>Retry check</button>');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('role="status"');
  });
  it('does not mistake a PATH CLI for Claude’s SDK-managed native executable', () => {
    const value = report();
    value.provider = 'claude';
    value.checks[3] = { id: 'executable', status: 'unverified', code: 'executable_unverified' };
    const html = render(checked(value));
    expect(html).toContain('SDK-managed native executable was not inspected');
    expect(html).toContain('PATH CLI or configured shell command does not verify this transport');
    expect(html).toContain('launch remains unverified');
  });
  it('disables Retry during an actual create request', () => {
    expect(render(checked(), 'en', true)).toContain('disabled=""');
  });
  it.each([
    ['scope', 'tenant_required', 'Select a mission you can access'],
    ['adapter', 'adapter_unavailable', 'Choose a supported provider'],
    ['egress_policy', 'egress_denied', 'zero-retention requirements'],
    ['executable', 'executable_missing', 'verify the CLI installation'],
    ['artifact_destination', 'artifact_unavailable', 'could not be safely inspected'],
  ] as const)(
    'provides a specific next step for %s without granting access',
    (id, code, instruction) => {
      const value = report();
      value.checks = value.checks.map((check) =>
        check.id === id ? { id, status: 'blocked', code } : check
      );
      if (id === 'scope' || id === 'adapter')
        value.checks[2] = { id: 'egress_policy', status: 'unverified', code: 'egress_unverified' };
      const html = render(checked(value));
      expect(html).toContain('Resolve the listed blockers');
      expect(html).toContain(instruction);
      expect(html).toContain('Blocked');
      expect(html).not.toContain('You may explicitly attempt generation');
      if (id === 'artifact_destination')
        expect(html).toContain('does not establish that it is unwritable');
    }
  );
  it('offers safe retry guidance without displaying raw failure details', () => {
    const html = render({
      phase: 'failed',
      selection: null,
      report: null,
      failure: 'unavailable',
      error: '/private/token-secret',
    } as DiscussionReadinessState);
    expect(html).toContain('Generation is disabled');
    expect(html).toContain('Retry the check');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('token-secret');
    expect(html).not.toContain('disabled=""');
  });
  it('explains the existing localadmin requirement on access failure', () => {
    expect(render({ phase: 'failed', selection: null, report: null, failure: 'access' })).toContain(
      'requires localadmin access'
    );
  });
  it('gives localized mission selection guidance for missing or hidden linked missions', () => {
    const failed: DiscussionReadinessState = {
      phase: 'failed',
      selection: null,
      report: null,
      failure: 'mission',
    };
    const html = render(failed);
    expect(html).toContain('Select another visible confidential mission or clear the mission link');
    expect(html).not.toContain('disabled=""');
    expect(render(failed, 'ja')).toContain('ミッションの紐づけを解除して再確認');
  });
  it('describes existing access and confidential scope together for 403 failures', () => {
    const html = render({ phase: 'failed', selection: null, report: null, failure: 'access' });
    expect(html).toContain('localadmin access and an allowed confidential scope');
    expect(html).toContain('verify your existing access and selected scope');
  });
  it('renders localized uncertainty, provider-call count, blockers and retry in Japanese', () => {
    const value = report();
    value.checks[2] = { id: 'egress_policy', status: 'blocked', code: 'egress_denied' };
    const html = render(checked(value), 'ja');
    expect(html).toContain('プロバイダーの設定確認');
    expect(html).toContain('0回');
    expect(html).toContain('目的の本文は送信しません');
    expect(html).toContain('実行時の書き込みは未確認');
    expect(html).toContain('ゼロ保持');
    expect(html).toContain('ここでは方針を変更しません');
    expect(html).toContain('>再確認</button>');
  });
});

describe('uncertain real-brief create disclosure', () => {
  it('requires original request proof rather than setup checks or the recent-room list', () => {
    const html = renderToStaticMarkup(createElement(DiscussionCreateUncertainty, { locale: 'en' }));
    expect(html).toContain('Check the original request receipt before any new room');
    expect(html).toContain('lost create response does not prove that no run started');
    expect(html).toContain('Setup checks and Recent rooms do not resolve a pending create request');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('idempotent');
  });
  it('provides the same uncertain-create boundary in Japanese', () => {
    const html = renderToStaticMarkup(createElement(DiscussionCreateUncertainty, { locale: 'ja' }));
    expect(html).toContain('元のリクエストの受付記録を確認');
    expect(html).toContain('実行が開始されなかったとは限りません');
    expect(html).toContain('設定確認や「過去のルーム」への表示では');
    expect(html).toContain('未確認の作成リクエストは解消されません');
  });
});

it('preserves the confidential and zero-retention prerequisite disclosure in Japanese before any result', () => {
  const html = render({ phase: 'idle', selection: null, report: null }, 'ja');
  expect(html).toContain('公開文書を貼り付けても');
  expect(html).toContain('機密扱い');
  expect(html).toContain('ゼロ保持設定と外部送信の許可');
});
