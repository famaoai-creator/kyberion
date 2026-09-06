import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { MissionWorkingMemory } from './mission-working-memory.js';

describe('mission-working-memory', () => {
  it('stores mission-scoped entries and produces a summary', () => {
    const memory = new MissionWorkingMemory();
    const missionId = `MSN-1-${randomUUID()}`.toUpperCase();
    memory.write({
      mission_id: missionId,
      scope: 'task',
      task_id: 'TASK-1',
      key: 'finding',
      value: 'Payment timeout spikes after vendor API retries.',
      writer_agent: 'reviewer-a',
    });
    memory.write({
      mission_id: missionId,
      scope: 'mission',
      key: 'next_step',
      value: 'Verify retry budget before rollout.',
      writer_agent: 'owner-a',
    });

    expect(memory.list({ missionId, scope: 'task' })).toHaveLength(1);
    expect(memory.summarize(missionId)).toContain('Payment timeout spikes');
    expect(memory.summarize(missionId)).toContain('next_step');
  });

  it('keeps restricted working-memory entries tenant and mission scoped', () => {
    const memory = new MissionWorkingMemory();
    const missionId = `MSN-SCOPE-${randomUUID()}`.toUpperCase();
    memory.write({
      mission_id: missionId,
      key: 'secret',
      value: 'tenant-only finding',
      writer_agent: 'planner',
      scope_context: {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        organization_id: 'org-a',
        mission_id: missionId,
        owner_nhi: 'kyberion://agent/org-a/planner',
      },
    });

    expect(
      memory.list({
        missionId,
        scopeContext: {
          tier: 'confidential',
          tenant_slug: 'acme-corp',
          organization_id: 'org-a',
          mission_id: missionId,
        },
      })
    ).toHaveLength(1);
    expect(
      memory.list({
        missionId,
        scopeContext: {
          tier: 'confidential',
          tenant_slug: 'other-corp',
          organization_id: 'org-a',
          mission_id: missionId,
        },
      })
    ).toHaveLength(0);
  });

  it('does not load schema-invalid persisted entries', () => {
    const missionId = `MSN-MWM-INVALID-${randomUUID()}`.toUpperCase();
    const missionDir = pathResolver.active(path.join('missions', 'confidential', missionId));
    const entriesPath = path.join(missionDir, '.mwm-entries.json');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        entriesPath,
        JSON.stringify([
          {
            entry_id: 'MWM-INVALID',
            mission_id: missionId,
            scope: 'mission',
            key: 'secret',
          },
        ])
      );
    });

    try {
      expect(new MissionWorkingMemory().list({ missionId })).toEqual([]);
    } finally {
      withExecutionContext('mission_controller', () =>
        safeRmSync(missionDir, { recursive: true, force: true })
      );
    }
  });
});
