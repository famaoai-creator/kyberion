import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';
import {
  DiscussionExecutionStatus,
  DiscussionProviderPrerequisite,
} from './DiscussionExecutionStatus';

function render(execution: unknown) {
  return renderToStaticMarkup(
    createElement(DiscussionExecutionStatus, {
      room: { execution } as DiscussionRoomState,
      locale: 'en',
    })
  );
}
describe('Discussion execution status rendering', () => {
  it('renders the durable failure reason even after a previous successful call', () => {
    const html = renderToStaticMarkup(
      createElement(DiscussionExecutionStatus, {
        room: {
          execution: null,
          error: '[DISCUSSION_EGRESS_DENIED] Existing policy denied this provider.',
        } as DiscussionRoomState,
        locale: 'en',
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Existing policy denied this provider.');
  });
  it('does not turn legacy or selected-only provenance into success', () => {
    expect(render(null)).toContain('Execution provenance unavailable');
    const html = render({
      actual_mode: 'reasoning',
      requested_provider: 'claude',
      provider: null,
      call_budget: 1,
      attempts: [],
    });
    expect(html).toContain('Provider response not confirmed');
    expect(html).not.toContain('Provider response received');
    expect(html).toContain('Exact model: unknown');
    expect(html).toContain('role="status"');
  });
  it('keeps scripted output explicitly offline', () => {
    const html = render({ actual_mode: 'scripted' });
    expect(html).toContain('Scripted output');
    expect(html).toContain('no model call');
    expect(html).not.toContain('Responding provider');
  });
  it('renders observed successful calls separately from started calls', () => {
    const html = render({
      actual_mode: 'reasoning',
      requested_provider: 'codex',
      provider: 'codex',
      call_budget: 2,
      attempts: [{ status: 'succeeded' }, { status: 'failed' }],
    });
    expect(html).toContain('Provider response received');
    expect(html).toContain('Started invocations');
    expect(html).toContain('2/2');
    expect(html).toContain('Successful invocations');
    expect(html).toContain('1');
  });
});

describe('Discussion provider prerequisite disclosure', () => {
  it('discloses confidential policy and unverified readiness before a real launch', () => {
    const html = renderToStaticMarkup(
      createElement(DiscussionProviderPrerequisite, { locale: 'en' })
    );
    expect(html).toContain('Provider readiness is not verified here');
    expect(html).toContain('Browser rooms use confidential scope');
    expect(html).toContain('zero-retention egress');
    expect(html).toContain('before any model invocation');
    expect(html).toContain('does not change scope or grant access');
  });
  it('provides the prerequisite disclosure in Japanese', () => {
    const html = renderToStaticMarkup(
      createElement(DiscussionProviderPrerequisite, { locale: 'ja' })
    );
    expect(html).toContain('未確認');
    expect(html).toContain('機密扱い');
    expect(html).toContain('ゼロ保持');
  });
});
