import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkItem, updateWorkItem, type WorkItem } from './work-coordination.js';
import {
  applyWorkflowDisposition,
  isWorkflowDisposition,
  WORKFLOW_DISPOSITIONS,
} from './workflow-disposition.js';

vi.mock('./work-coordination.js', async (original) => ({
  ...(await original<typeof import('./work-coordination.js')>()),
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));

describe('disposition admission', () => {
  const request = { itemId: 'test-item', actorId: 'owner', expectedVersion: 2 };
  beforeEach(() => vi.resetAllMocks());

  it('fences the write after observing the authorized version', () => {
    vi.mocked(getWorkItem).mockReturnValue({ status: 'blocked', version: 2 } as WorkItem);
    applyWorkflowDisposition({ ...request, disposition: 'retry' });
    expect(updateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 2, status: 'ready' })
    );
  });

  it.each([
    [{ version: 3 }, 'version_conflict'],
    [{ lease_id: 'lease' }, 'lease_conflict'],
    [{ metadata: { verification_step: true } }, 'validation_error'],
  ] as const)('stops unsafe disposition before writing (%s)', (patch, code) => {
    vi.mocked(getWorkItem).mockReturnValue({ status: 'blocked', version: 2, ...patch } as WorkItem);
    expect(() => applyWorkflowDisposition({ ...request, disposition: 'skip' })).toThrow(
      expect.objectContaining({ code })
    );
    expect(updateWorkItem).not.toHaveBeenCalled();
  });
});

describe('workflow disposition vocabulary', () => {
  it('accepts only the four card actions', () => {
    expect(WORKFLOW_DISPOSITIONS).toEqual(['retry', 'skip', 'reassign', 'accept']);
    for (const action of WORKFLOW_DISPOSITIONS) {
      expect(isWorkflowDisposition(action)).toBe(true);
    }
    expect(isWorkflowDisposition('later')).toBe(false);
    expect(isWorkflowDisposition('approve')).toBe(false);
    expect(isWorkflowDisposition('rewrite_step')).toBe(false);
  });
});
