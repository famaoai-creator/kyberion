import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile, safeRmSync } from '../secure-io.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { CONTINUOUS_MANAGED_WORK_PIPELINE } from './continuous-work-plan.js';
import {
  runContinuousWorkOwner,
  readContinuousWorkOwnerProgress,
  type ContinuousWorkOwnerDeps,
  type ContinuousWorkOwnerPorts,
} from './continuous-work-owner.js';
const mission = {
  key: 'diagnose',
  title: 'Diagnose',
  goal: 'Understand failure',
  success_condition: 'Evidence collected',
};
const charter = {
  dot_id: 'operator',
  status: 'active',
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org',
    project_id: 'PRJ-EXISTING',
  },
  authority: {
    authority_role: 'organization_operator',
    allowed_work_shapes: ['pipeline'],
    allowed_pipelines: [CONTINUOUS_MANAGED_WORK_PIPELINE],
    max_concurrent_delegations: 2,
  },
} as DotCharter;
function fixture(kind = 'mission') {
  let item = {
    item_id: 'WI-ONE',
    title: 'Managed',
    status: 'ready',
    version: 1,
    created_at: '2026-10-18T00:00:00Z',
    context: { tenant_slug: 'acme', organization_id: 'org', project_id: 'PRJ-EXISTING' },
    metadata: {
      dot_id: 'operator',
      action_ref: 'action-1',
      decision: 'approve',
      approval_request_id: 'actual-request',
      pipeline_ref: CONTINUOUS_MANAGED_WORK_PIPELINE,
      continuous_work: {
        kind,
        ...(kind === 'project'
          ? { project: { name: 'New project', summary: 'Improve quality' } }
          : {}),
        missions: [structuredClone(mission)],
      },
    },
  } as unknown as WorkItem;
  const files = new Map<string, unknown>();
  const ports: ContinuousWorkOwnerPorts = {
    ensureProject: vi.fn(async (input) => ({ project_id: input.project_id })),
    ensureMission: vi.fn(async (input) => ({ mission_id: input.mission_id })),
    advanceMission: vi.fn(async () => ({
      status: 'pending_approval',
      evidence_refs: ['evidence:brief'],
      approval_request_id: 'alignment-1',
    })),
  };
  const deps: ContinuousWorkOwnerDeps = {
    currentCharter: () => charter,
    authorize: () => undefined,
    authorizeItem: () => undefined,
    halted: () => false,
    throttled: () => false,
    list: () => [item],
    get: () => item,
    lock: async (_key, fn) => fn(),
    read: (file) => structuredClone(files.get(file)),
    write: (file, value) => {
      files.set(file, structuredClone(value));
    },
    claim: vi.fn(() => {
      item = {
        ...item,
        status: 'in_progress',
        lease_id: 'lease-1',
        claimed_by_peer_id: 'dot:operator',
      };
      return { item, lease: { lease_id: 'lease-1' } };
    }) as unknown as ContinuousWorkOwnerDeps['claim'],
    renew: vi.fn(() => ({ lease_id: 'lease-1' })) as unknown as ContinuousWorkOwnerDeps['renew'],
    release: vi.fn((input: { nextStatus: WorkItem['status'] }) => {
      item = {
        ...item,
        status: input.nextStatus,
        lease_id: undefined,
        claimed_by_peer_id: undefined,
      };
      return { item, lease: { lease_id: 'lease-1' } };
    }) as unknown as ContinuousWorkOwnerDeps['release'],
  };
  return {
    ports,
    deps,
    files,
    item: () => item,
    run: () => runContinuousWorkOwner(charter, ports, { rootDir: pathResolver.rootDir() }, deps),
  };
}
describe('continuous managed owner', () => {
  it('threads only the admitted development descriptor to creation and each owner advancement', async () => {
    const h = fixture();
    const development = {
      cwd: '.',
      repository_url: 'https://github.com/owner/repository',
      source_edit_paths: ['libs/core/example.ts'],
      implementation_task_id: 'execution-implement',
      review_task_id: 'self_review-code-review',
      title: 'fix: restore reliability',
      body_file: 'evidence/pr-body.md',
    };
    const plan = h.item().metadata!.continuous_work as { missions: Array<Record<string, unknown>> };
    plan.missions[0]!.development = development;
    await h.run();
    expect(h.ports.ensureMission).toHaveBeenCalledWith(expect.objectContaining({ development }));
    expect(h.ports.advanceMission).toHaveBeenCalledWith(expect.objectContaining({ development }));
  });
  it('reads the exact halt flag file under a scratch checkout and stands down only when halted', async () => {
    const scratchName = `vitest-continuous-owner-halt-${randomUUID()}`;
    const root = pathResolver.rootResolve(`active/shared/tmp/${scratchName}`);
    const haltFile = path.join(root, 'active/shared/runtime/governance/operations-halt.json');
    withExecutionContext('infrastructure_sentinel', () => safeMkdir(root, { recursive: true }));
    try {
      const f = fixture();
      delete f.deps.halted;
      expect(
        (await runContinuousWorkOwner(charter, f.ports, { rootDir: root }, f.deps))[0]?.status
      ).toBe('pending_approval');
      expect(f.ports.ensureMission).toHaveBeenCalledTimes(1);
      withExecutionContext('infrastructure_sentinel', () =>
        safeWriteFile(haltFile, JSON.stringify({ halted: true, by: 'test' }))
      );
      const g = fixture();
      delete g.deps.halted;
      expect(await runContinuousWorkOwner(charter, g.ports, { rootDir: root }, g.deps)).toEqual([]);
      expect(g.deps.claim).not.toHaveBeenCalled();
      expect(g.ports.ensureMission).not.toHaveBeenCalled();
    } finally {
      if (
        path.basename(root) !== scratchName ||
        path.relative(pathResolver.rootResolve('active/shared/tmp'), root) !== scratchName
      )
        throw new Error('Refusing cleanup outside the unique test workspace');
      withExecutionContext('infrastructure_sentinel', () => safeRmSync(haltFile, { force: true }));
    }
  });
  it('revalidates approval in the original charter role during a mission-controller port', async () => {
    const f = fixture();
    const roles: string[] = [];
    vi.mocked(f.ports.ensureMission).mockImplementation(async (input) => {
      f.deps.authorize = () => {
        roles.push(currentExecutionScope()?.assumedRole ?? 'missing');
      };
      f.deps.authorizeItem = () => {
        throw new Error('approval revoked during child command');
      };
      withExecutionContext('mission_controller', () => input.assertCurrent());
      throw new Error('must not reach another effect');
    });
    expect((await f.run())[0]?.reason).toContain('approval revoked');
    expect(roles).toEqual(['organization_operator']);
    expect(f.item().status).toBe('blocked');
    expect(f.ports.advanceMission).not.toHaveBeenCalled();
    expect(f.deps.release).toHaveBeenCalledWith(
      expect.not.objectContaining({ effectDisposition: 'completed' })
    );
  });
  it('refuses a second port effect after lease loss', async () => {
    const f = fixture();
    vi.mocked(f.ports.ensureMission).mockImplementation(async (input) => {
      f.item().lease_id = 'replacement-lease';
      input.assertCurrent();
      throw new Error('must not reach another effect');
    });
    expect((await f.run())[0]?.reason).toContain('Owner lease changed');
    expect(f.ports.advanceMission).not.toHaveBeenCalled();
  });
  it('rechecks a returning port before committing its checkpoint', async () => {
    const f = fixture();
    vi.mocked(f.ports.ensureMission).mockImplementation(async (input) => {
      f.deps.authorizeItem = () => {
        throw new Error('approval revoked just before return');
      };
      return { mission_id: input.mission_id };
    });
    expect((await f.run())[0]?.reason).toContain('approval revoked');
    const checkpoint = [...f.files.values()][0] as {
      intent: string;
      missions: Record<string, { created: boolean }>;
    };
    expect(checkpoint.intent).toBe('ensure-mission:diagnose');
    expect(checkpoint.missions.diagnose!.created).toBe(false);
    expect(f.ports.advanceMission).not.toHaveBeenCalled();
  });
  it('reads absent, running and completed checkpoints without claims or effects', async () => {
    const f = fixture();
    const options = { rootDir: pathResolver.rootDir() };
    expect(readContinuousWorkOwnerProgress(charter, f.item(), options, f.deps)).toBeUndefined();
    await f.run();
    vi.mocked(f.deps.claim!).mockClear();
    vi.mocked(f.ports.advanceMission).mockClear();
    expect(readContinuousWorkOwnerProgress(charter, f.item(), options, f.deps)?.status).toBe(
      'pending_approval'
    );
    expect(f.deps.claim).not.toHaveBeenCalled();
    expect(f.ports.advanceMission).not.toHaveBeenCalled();
    vi.mocked(f.ports.advanceMission).mockResolvedValue({
      status: 'completed',
      evidence_refs: ['verified:result'],
    });
    await f.run();
    expect(readContinuousWorkOwnerProgress(charter, f.item(), options, f.deps)).toEqual(
      expect.objectContaining({
        status: 'completed',
        missions: { diagnose: expect.objectContaining({ evidence_refs: ['verified:result'] }) },
      })
    );
    const [key] = [...f.files.keys()];
    f.files.set(key!, { invalid: true });
    expect(() => readContinuousWorkOwnerProgress(charter, f.item(), options, f.deps)).toThrow(
      'identity mismatch'
    );
  });
  it('creates targets once and keeps approval pending across restart without starting work', async () => {
    const f = fixture('project');
    expect((await f.run())[0]?.status).toBe('pending_approval');
    expect((await f.run())[0]?.status).toBe('pending_approval');
    expect(f.ports.ensureProject).toHaveBeenCalledTimes(1);
    expect(f.ports.ensureMission).toHaveBeenCalledTimes(1);
    expect(f.deps.release).not.toHaveBeenCalled();
    expect([...f.files.keys()][0]).toContain('/runtime/confidential/acme/continuous-work/');
  });
  it('persists uncertain effects and refuses automatic replay', async () => {
    const f = fixture();
    vi.mocked(f.ports.ensureMission).mockRejectedValue(new Error('child timed out after creation'));
    expect((await f.run())[0]?.status).toBe('blocked');
    expect(await f.run()).toEqual([]);
    expect(f.item().status).toBe('blocked');
    expect(f.deps.release).toHaveBeenCalledWith(
      expect.not.objectContaining({ effectDisposition: 'completed' })
    );
    expect(f.ports.ensureMission).toHaveBeenCalledTimes(1);
    expect(f.ports.advanceMission).not.toHaveBeenCalled();
  });
  it('refuses checkpoint plan tampering and lapsed leases before effects', async () => {
    const f = fixture();
    await f.run();
    (f.item().metadata!.continuous_work as { missions: (typeof mission)[] }).missions[0]!.goal =
      'Different goal';
    expect((await f.run())[0]?.reason).toContain('identity mismatch');
    expect(f.ports.advanceMission).toHaveBeenCalledTimes(1);
    const g = fixture();
    await g.run();
    vi.mocked(g.deps.renew!).mockImplementation(() => {
      throw new Error('lease already lapsed');
    });
    expect((await g.run())[0]?.reason).toContain('lapsed');
    expect(g.ports.advanceMission).toHaveBeenCalledTimes(1);
  });
  it('rechecks authorization immediately before effects and settles only completed work', async () => {
    const f = fixture();
    vi.mocked(f.ports.advanceMission).mockResolvedValue({
      status: 'completed',
      evidence_refs: ['mission:completed'],
    });
    expect((await f.run())[0]?.status).toBe('completed');
    expect(f.deps.release).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'done', effectDisposition: 'completed' })
    );
    const g = fixture();
    let checks = 0;
    g.deps.authorizeItem = () => {
      if (++checks > 1) throw new Error('approval revoked');
    };
    expect((await g.run())[0]?.reason).toContain('revoked');
    expect(g.ports.ensureMission).not.toHaveBeenCalled();
  });
  it('hard budget and halt prevent claims and owner effects', async () => {
    const f = fixture();
    f.deps.throttled = () => true;
    expect(await f.run()).toEqual([]);
    expect(f.deps.claim).not.toHaveBeenCalled();
  });
  it('creates prerequisite missions first and waits for their completion before advancing dependents', async () => {
    const f = fixture('mission_group');
    (f.item().metadata!.continuous_work as { missions: unknown[] }).missions = [
      { ...mission, key: 'repair', depends_on: ['diagnose'] },
      mission,
    ];
    const first = (await f.run())[0]!;
    expect(f.ports.ensureMission).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: 'diagnose', prerequisites: [] })
    );
    expect(f.ports.ensureMission).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: 'repair',
        prerequisites: [first.missions!.diagnose!.mission_id],
      })
    );
    expect(f.ports.advanceMission).toHaveBeenCalledTimes(1);
    vi.mocked(f.ports.advanceMission).mockResolvedValue({
      status: 'completed',
      evidence_refs: ['verified:result'],
    });
    expect((await f.run())[0]?.status).toBe('completed');
    expect(f.ports.advanceMission).toHaveBeenCalledTimes(3);
    expect(f.ports.ensureMission).toHaveBeenCalledTimes(2);
  });
  it('quarantines an uncertain operation so a later approved item is not starved', async () => {
    const f = fixture();
    let second = {
      ...structuredClone(f.item()),
      item_id: 'WI-TWO',
      metadata: { ...structuredClone(f.item().metadata), action_ref: 'action-2' },
    };
    f.deps.list = () => [f.item(), second];
    f.deps.get = (id) => (id === 'WI-TWO' ? second : f.item());
    const claimFirst = f.deps.claim!;
    f.deps.claim = ((input) => {
      if (input.itemId !== 'WI-TWO') return claimFirst(input);
      second = {
        ...second,
        status: 'in_progress',
        lease_id: 'lease-2',
        claimed_by_peer_id: 'dot:operator',
      };
      return { item: second, lease: { lease_id: 'lease-2' } };
    }) as ContinuousWorkOwnerDeps['claim'];
    vi.mocked(f.ports.ensureMission).mockRejectedValueOnce(new Error('uncertain child effect'));
    expect((await f.run())[0]?.status).toBe('blocked');
    expect(f.item().status).toBe('blocked');
    expect((await f.run())[0]).toEqual(
      expect.objectContaining({ work_item_id: 'WI-TWO', status: 'pending_approval' })
    );
    expect(f.ports.ensureMission).toHaveBeenCalledTimes(2);
  });
  it('quarantines an expired approval before checkpoint creation and admits the next ready item', async () => {
    const f = fixture();
    Object.assign(f.item(), {
      status: 'in_progress',
      lease_id: 'lease-1',
      claimed_by_peer_id: 'dot:operator',
      effect_ownership: { state: 'held', target: 'operation:first' },
    });
    let second = {
      ...structuredClone(f.item()),
      item_id: 'WI-TWO',
      status: 'ready' as WorkItem['status'],
      lease_id: undefined,
      claimed_by_peer_id: undefined,
      effect_ownership: undefined,
      metadata: { ...structuredClone(f.item().metadata), action_ref: 'action-2' },
    };
    f.deps.list = () => [f.item(), second];
    f.deps.get = (id) => (id === second.item_id ? second : f.item());
    f.deps.authorizeItem = (_charter, item) => {
      if (item.item_id === 'WI-ONE') throw new Error('approval expired');
    };
    f.deps.claim = ((input) => {
      second = {
        ...second,
        status: 'in_progress',
        lease_id: 'lease-2',
        claimed_by_peer_id: 'dot:operator',
      };
      return { item: second, lease: { lease_id: 'lease-2' } };
    }) as ContinuousWorkOwnerDeps['claim'];
    expect((await f.run())[0]?.reason).toContain('approval expired');
    expect(f.files.size).toBe(0);
    expect(f.item().status).toBe('blocked');
    expect(f.item().effect_ownership?.state).toBe('held');
    expect(f.deps.release).toHaveBeenCalledWith(
      expect.not.objectContaining({ effectDisposition: 'completed' })
    );
    expect(f.ports.ensureMission).not.toHaveBeenCalled();
    expect((await f.run())[0]).toEqual(
      expect.objectContaining({ work_item_id: 'WI-TWO', status: 'pending_approval' })
    );
    expect(f.ports.ensureMission).toHaveBeenCalledTimes(1);
  });
});
