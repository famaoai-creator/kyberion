import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { reduceDiscussionRoom } from '@agent/core/discussion/discussion-reducer';
import { OutcomesCard } from './DiscussionOutcomes';

describe('discussion saved artifact actions', () => {
  it('renders distinct saved bytes and generated review actions bound to this room', () => {
    const room = reduceDiscussionRoom('disc-ui', []);
    room.outcomes.minutes = {
      artifact_id: 'ART-minutes',
      kind: 'markdown',
      path: 'active/shared/runtime/discussions/disc-ui/minutes.md',
    };
    room.outcomes.brief = {
      artifact_id: 'ART-brief',
      path: 'active/shared/runtime/discussions/disc-ui/brief.html',
    };
    const html = renderToStaticMarkup(
      createElement(OutcomesCard, { room, locale: 'en', canSteer: true, onRoom: () => undefined })
    );
    expect(html).toContain('href="/api/discussions/disc-ui/artifacts/ART-minutes"');
    expect(html).toContain('href="/api/discussions/disc-ui/artifacts/ART-brief"');
    expect(html).toContain('Saved minutes');
    expect(html).toContain('Saved brief');
    expect(html).toContain('View current brief');
    expect(html).toContain('Review and decide');
    expect(html).not.toContain('/api/mission-asset');
  });

  it('keeps saved bytes available to readonly viewers without review controls', () => {
    const room = reduceDiscussionRoom('disc-readonly', []);
    room.outcomes.brief = {
      artifact_id: 'ART-brief',
      path: 'active/shared/runtime/discussions/disc-readonly/brief.html',
    };
    const html = renderToStaticMarkup(
      createElement(OutcomesCard, { room, locale: 'en', canSteer: false, onRoom: () => undefined })
    );
    expect(html).toContain('Saved brief');
    expect(html).toContain('View current brief');
    expect(html).not.toContain('Review and decide');
  });
});
