import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscussionRoomState } from '@agent/core/discussion/discussion-types';
import { DiscussionBriefControls } from './DiscussionBriefControls';
describe('single-model brief controls', () => {
  const render = (status: string, canSteer = true) =>
    renderToStaticMarkup(
      createElement(DiscussionBriefControls, {
        room: { id: 'fixture', status } as DiscussionRoomState,
        locale: 'en',
        canSteer,
        onRoom: () => undefined,
      })
    );
  it('renders Stop only with an honest single-model limitation', () => {
    const html = render('running');
    expect(html).toContain('>Stop</button>');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('No panel deliberation or evidence verification');
    expect(html).not.toContain('Pause');
    expect(html).not.toContain('vote');
  });
  it.each(['concluded', 'stopped', 'failed'])('has no execution controls in %s', (status) => {
    expect(render(status)).not.toContain('<button');
  });
  it('does not allow a read-only viewer to stop execution', () => {
    expect(render('running', false)).toContain('disabled=""');
  });
});
