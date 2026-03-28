import { afterEach, describe, expect, it } from 'vitest';
import {
  createSurfaceAsyncRequest,
  enqueueSurfaceNotification,
  getSurfaceAsyncRequest,
  listSurfaceAsyncRequests,
  listSurfaceNotifications,
  updateSurfaceAsyncRequest,
} from './channel-surface.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';

describe('channel-surface async request store', () => {
  afterEach(() => {
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'surface_runtime';
    safeRmSync(pathResolver.resolve('active/shared/runtime/presence/requests'), { recursive: true, force: true });
    safeRmSync(pathResolver.resolve('active/shared/runtime/presence/notifications'), { recursive: true, force: true });
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
  });

  it('creates and updates a presence async request', () => {
    const request = createSurfaceAsyncRequest({
      surface: 'presence',
      channel: 'voice',
      threadTs: 'voice-thread',
      senderAgentId: 'kyberion:voice-hub',
      surfaceAgentId: 'presence-surface-agent',
      receiverAgentId: 'chronos-mirror',
      query: 'システム状態を教えて',
      acceptedText: 'accepted',
    });

    expect(getSurfaceAsyncRequest('presence', request.request_id)?.status).toBe('pending');

    updateSurfaceAsyncRequest('presence', request.request_id, {
      status: 'completed',
      result_text: 'done',
      completed_at: new Date().toISOString(),
    });

    const listed = listSurfaceAsyncRequests('presence');
    expect(listed[0]?.status).toBe('completed');
    expect(listed[0]?.result_text).toBe('done');
  });

  it('stores surface notifications', () => {
    enqueueSurfaceNotification({
      surface: 'presence',
      channel: 'voice',
      threadTs: 'voice-thread',
      sourceAgentId: 'chronos-mirror',
      title: 'Complete',
      text: 'result text',
      status: 'success',
      requestId: 'REQ-TEST',
    });

    const notifications = listSurfaceNotifications('presence');
    expect(notifications[0]?.title).toBe('Complete');
    expect(notifications[0]?.request_id).toBe('REQ-TEST');
  });
});
