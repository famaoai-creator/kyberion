import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkItemMissionAlignmentAction } from './WorkItemMissionAlignmentAction';
import type { ClientWorkItem } from '../lib/workitems-response';
const item: ClientWorkItem = {
  item_id: 'WI-1',
  status: 'blocked',
  title: 'Scoped intake',
  description: 'Prepare a reviewed mission',
  priority: 'normal',
  source: 'local',
  source_ref: 'fixture',
  project_id: 'proj-a',
  labels: [],
  dependencies: [],
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  context: { tenant_slug: 'tenant-a' },
  metadata: { admission_only: true, requested_work_shape: 'mission' },
};
const requestId = '11111111-1111-4111-8111-111111111111';
const render = (props = {}) =>
  renderToStaticMarkup(
    createElement(WorkItemMissionAlignmentAction, {
      item,
      busy: false,
      locale: 'en',
      onRequest: vi.fn(),
      ...props,
    })
  );
describe('mission alignment action presentation', () => {
  it('invokes the request callback with only the original WorkItem id', () => {
    const onRequest = vi.fn();
    const element = WorkItemMissionAlignmentAction({
      item,
      busy: false,
      locale: 'en',
      onRequest,
    });
    const button = element!.props.children[0];
    button.props.onClick();
    expect(onRequest).toHaveBeenCalledExactlyOnceWith('WI-1');
  });
  it('offers explicit preparation only for held mission intake', () => {
    expect(render()).toContain('Request mission approval');
    expect(render({ item: { ...item, status: 'done' } })).toBe('');
    expect(render({ item: { ...item, metadata: {} } })).toBe('');
  });
  it('disables duplicate interaction while preparing', () => {
    expect(render({ busy: true })).toContain('disabled');
  });
  it('shows the exact pending request and explicitly not started work', () => {
    const html = render({
      admission: { requestId, missionId: 'MSN-ONE', status: 'pending' },
    });
    expect(html).toContain('work has not started');
    expect(html).toContain(requestId);
    expect(html).toContain('section=approvals');
    expect(html).not.toContain('task completed');
  });
  it('distinguishes approved waiting from activation', () => {
    expect(
      render({ admission: { requestId, missionId: 'MSN-ONE', status: 'approved' } })
    ).toContain('waiting for governed activation');
  });
  it.each(['expired', 'rejected'])('shows %s as held', (status) => {
    expect(render({ admission: { requestId, missionId: 'MSN-ONE', status } })).toContain(
      'Admission remains held'
    );
  });
});
