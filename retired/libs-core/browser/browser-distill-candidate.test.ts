import { describe, expect, it } from 'vitest';
import { assessBrowserDistillCandidate } from './browser-distill-candidate.js';

describe('browser-distill-candidate', () => {
  it('rejects open-site navigation without an interactive apply step', () => {
    const result = assessBrowserDistillCandidate({
      origin: 'open_site',
      goalSummary: 'Example site opened',
      previewText: 'Opened https://example.com.',
      tracePath: '/tmp/trace.zip',
      actionTrailCount: 3,
      recentActions: [
        { kind: 'control', op: 'goto' },
        { kind: 'capture', op: 'tabs' },
        { kind: 'capture', op: 'snapshot' },
      ],
      targetUrl: 'https://example.com',
      windowTitle: 'Example Domain',
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/interactive apply step/i);
  });

  it('accepts browser workflows with trace and interactive actions', () => {
    const result = assessBrowserDistillCandidate({
      origin: 'conversation_action',
      goalSummary: 'Hotel search workflow',
      previewText: 'Clicked search and confirmed the result.',
      tracePath: '/tmp/trace.zip',
      actionTrailCount: 5,
      recentActions: [
        { kind: 'control', op: 'select_tab' },
        { kind: 'capture', op: 'snapshot' },
        { kind: 'apply', op: 'click_ref' },
        { kind: 'capture', op: 'snapshot' },
      ],
      targetUrl: 'https://example.com/search',
      windowTitle: 'Search results',
    });

    expect(result.eligible).toBe(true);
    expect(result.targetKind).toBe('pattern');
  });
});
