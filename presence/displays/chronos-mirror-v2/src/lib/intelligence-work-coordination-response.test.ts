import { describe, expect, it } from 'vitest';
import { parseWorkCoordinationResponse } from './intelligence-work-coordination-response';

const summary = {
  total: 1,
  backlog: 0,
  ready: 1,
  inProgress: 0,
  blocked: 0,
  review: 0,
  done: 0,
  archived: 0,
  runningAttempts: 0,
  recentItems: [
    {
      item_id: 'work-1',
      title: 'Review projection',
      status: 'ready',
      priority: 'normal',
      project_id: 'project-1',
      source_ref: 'mission-1',
      updated_at: '2026-09-04T00:00:00.000Z',
      attempt_count: 0,
    },
  ],
};

describe('intelligence work coordination response boundary', () => {
  it('accepts the summary fields consumed by WorkItemsWorkspace', () => {
    expect(parseWorkCoordinationResponse({ workCoordination: summary })).toEqual(summary);
  });

  it('accepts an empty recent item list and optional attempt fields', () => {
    expect(
      parseWorkCoordinationResponse({
        workCoordination: { ...summary, recentItems: [] },
      })
    ).toMatchObject({ recentItems: [] });
    expect(
      parseWorkCoordinationResponse({
        workCoordination: {
          ...summary,
          recentItems: [
            {
              ...summary.recentItems[0],
              current_attempt_id: 'attempt-1',
              current_attempt_status: 'running',
              blocked_reason: '',
            },
          ],
        },
      })
    ).toBeDefined();
  });

  it('rejects invalid counters, item fields, and unsafe nested keys', () => {
    expect(
      parseWorkCoordinationResponse({ workCoordination: { ...summary, blocked: -1 } })
    ).toBeUndefined();
    expect(
      parseWorkCoordinationResponse({
        workCoordination: {
          ...summary,
          recentItems: [{ ...summary.recentItems[0], attempt_count: 1.5 }],
        },
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"workCoordination":{"total":1,"backlog":0,"ready":1,"inProgress":0,"blocked":0,"review":0,"done":0,"archived":0,"runningAttempts":0,"recentItems":[{"item_id":"work-1","title":"Review","status":"ready","priority":"normal","project_id":"project-1","source_ref":"mission-1","updated_at":"2026-09-04T00:00:00.000Z","attempt_count":0,"__proto__":"bad"}]}}'
    );
    expect(parseWorkCoordinationResponse(unsafe)).toBeUndefined();
  });
});
