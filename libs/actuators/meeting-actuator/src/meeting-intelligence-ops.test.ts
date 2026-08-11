import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkItem,
  getWorkItem,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '@agent/core';
import { delegateMeetingReasoning } from './meeting-intelligence-ops.js';

describe('meeting intelligence governed delegation', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace(`meeting-intelligence-test-${process.pid}`);
    clearWorkCoordinationStore();
  });
  afterEach(() => {
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
  });

  it('records successful work-item execution and native subagent proof', async () => {
    const item = createWorkItem({
      itemId: 'WI-MEETING-SUCCESS',
      title: 'meeting reasoning',
      description: 'test',
      projectId: 'M-MEETING',
      status: 'ready',
      context: {
        organization_id: 'org-meeting',
        tenant_slug: 'tenant-meeting',
        mission_id: 'M-MEETING',
        project_id: 'M-MEETING',
        task_id: 'extract-actions',
      },
    });
    const output = await delegateMeetingReasoning({
      backend: {
        name: 'native-test',
        delegateTask: async () => {
          throw new Error('legacy path used');
        },
        getNativeSubagentAdopter: () => ({
          id: 'native-adopter',
          dispatch: async () => '[{"title":"Send notes"}]',
          getInfo: () => ({ provider: 'native', model: 'test-model', threadId: 'thread-1' }),
        }),
      } as never,
      prompt: 'extract actions',
      context: 'meeting',
      mission_id: 'M-MEETING',
      work_item_id: item.item_id,
      task_id: 'extract-actions',
    });
    expect(output).toContain('Send notes');
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(getWorkItem(item.item_id)?.attempts?.[0]?.metadata).toMatchObject({
      native_subagent: { adopter_id: 'native-adopter' },
      lease_status: 'released',
      attempt_id: expect.any(String),
      security_scope: {
        tenant_id: 'tenant-meeting',
        organization_id: 'org-meeting',
        mission_id: 'M-MEETING',
        project_id: 'M-MEETING',
      },
    });
  });

  it('closes the work item as blocked when governed execution fails', async () => {
    const item = createWorkItem({
      itemId: 'WI-MEETING-BLOCKED',
      title: 'meeting reasoning',
      description: 'test',
      projectId: 'M-MEETING',
      status: 'ready',
      context: {
        organization_id: 'org-meeting',
        tenant_slug: 'tenant-meeting',
        mission_id: 'M-MEETING',
        project_id: 'M-MEETING',
        task_id: 'extract-actions',
      },
    });
    await expect(
      delegateMeetingReasoning({
        backend: {
          name: 'blocked-test',
          delegateTask: async () => {
            throw new Error('blocked by backend');
          },
        } as never,
        prompt: 'extract actions',
        context: 'meeting',
        mission_id: 'M-MEETING',
        work_item_id: item.item_id,
        task_id: 'extract-actions',
      })
    ).rejects.toThrow('blocked by backend');
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
    expect(getWorkItem(item.item_id)?.attempts?.[0]?.metadata).toMatchObject({
      lease_status: 'released',
      execution_status: 'failed',
    });
  });

  it('fails closed for mission-only calls instead of using the ephemeral delegate path', async () => {
    const delegateTask = async () => {
      throw new Error('legacy path used');
    };
    await expect(
      delegateMeetingReasoning({
        backend: { name: 'ephemeral-test', delegateTask } as never,
        prompt: 'extract actions',
        context: 'meeting',
        mission_id: 'M-MEETING',
        task_id: 'extract-actions',
      })
    ).rejects.toThrow('[MEETING_WORK_ITEM_REQUIRED]');
  });
});
