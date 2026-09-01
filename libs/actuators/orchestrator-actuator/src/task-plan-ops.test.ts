import { describe, expect, it } from 'vitest';
import { decomposeIntoTasks } from './task-plan-ops.js';

describe('orchestrator task-plan input boundaries', () => {
  it('rejects an external requirements draft before reading it', async () => {
    await expect(
      decomposeIntoTasks({
        mission_id: 'MSN-TASK-PLAN-PATH-BOUNDARY-001',
        project_name: 'boundary-check',
        requirements_draft_path: '/tmp/external-requirements-draft.json',
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
