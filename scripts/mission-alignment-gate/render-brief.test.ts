import { describe, expect, it } from 'vitest';

import { renderMissionBriefHtml } from './render-brief.js';

describe('renderMissionBriefHtml approval state', () => {
  it('serializes settled decision metadata for report-review readers', () => {
    const html = renderMissionBriefHtml(
      { missionId: 'MSN-RENDER-TEST', title: 'render test' },
      {
        approval: {
          requestId: 'apr-render-1',
          status: 'rejected',
          decidedBy: 'sovereign',
          decidedAt: '2026-08-11T12:00:00.000Z',
        },
      }
    );

    expect(html).toContain('data-decision="rejected"');
    expect(html).toContain('data-decided-by="sovereign"');
    expect(html).toContain('data-decided-at="2026-08-11T12:00:00.000Z"');
  });
});
