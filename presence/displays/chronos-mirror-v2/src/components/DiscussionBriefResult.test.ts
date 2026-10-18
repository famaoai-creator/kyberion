import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';
import { DiscussionBriefResult } from './DiscussionBriefResult';
describe('single brief partial result rendering', () => {
  it('preserves readable generated content after artifact publication failed', () => {
    const html = renderToStaticMarkup(
      createElement(DiscussionBriefResult, {
        room: {
          status: 'failed',
          decision: {
            summary: 'A generated fixture summary',
            dissent: ['Unverified source claim'],
            next_steps: ['Review the original text'],
          },
          outcomes: { minutes: null, brief: null },
        } as unknown as DiscussionRoomState,
        locale: 'en',
      })
    );
    expect(html).toContain('A generated fixture summary');
    expect(html).toContain('Unverified source claim');
    expect(html).toContain('Review the original text');
    expect(html).toContain('Tentative brief result');
    expect(html).not.toContain('Consensus');
  });
  it('does not invent a result before generation', () => {
    const html = renderToStaticMarkup(
      createElement(DiscussionBriefResult, {
        room: { decision: null } as DiscussionRoomState,
        locale: 'en',
      })
    );
    expect(html).toContain('No generated result is available yet');
  });
});
