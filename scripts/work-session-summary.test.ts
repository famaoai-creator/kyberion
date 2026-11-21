import { expect, it, vi } from 'vitest';
import { main } from './work/work_coordination.js';

const state = vi.hoisted(() => ({
  tenant: 'alpha',
  awaiting: true,
  held: true,
  artifacts: vi.fn(() => [
    {
      artifact_id: 'ART-A',
      kind: 'delivery-pack',
      path: 'active/shared/artifacts/delivery.json',
      storage_class: 'artifact_store',
      evidence_refs: ['verification.json'],
      metadata: { quality_verdict: 'pass', delivery_statuses: ['failed'] },
    },
  ]),
}));
vi.mock('@agent/core/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/authority')>()),
  resolveIdentityContext: () => ({ tenantSlug: state.tenant }),
}));
vi.mock('@agent/core/workforce/artifact-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/workforce/artifact-registry')>()),
  listArtifactOwnershipRecordsByQuery: state.artifacts,
}));
vi.mock('@agent/core/workforce/work-coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/workforce/work-coordination')>()),
  getWorkItem: () => ({
    item_id: 'WI-A',
    context: { tenant_slug: 'alpha', mission_id: 'MSN-A' },
    status: 'blocked',
    effect_ownership: { state: state.held ? 'held' : 'settled' },
    metadata: { dot_executor: { awaiting_approval: state.awaiting, approval_request_id: 'REQ-A' } },
  }),
}));

it('reopens the same item, distinguishes pending approval and unsettled effect, and conceals other tenants', async () => {
  const args = ['session-summary', '--item-id', 'WI-A', '--json'];
  const output = vi.fn();
  await main(args, output);
  expect(JSON.parse(output.mock.lastCall?.[0])).toMatchObject({
    next_action: 'inspect_approval',
    approval_request_id: 'REQ-A',
  });
  expect(state.artifacts).toHaveBeenCalledWith(
    expect.objectContaining({ tenantSlug: 'alpha', missionId: 'MSN-A', includeTmp: false })
  );
  const handoff = JSON.parse(output.mock.lastCall?.[0]);
  expect(handoff.mission_artifacts).toEqual([
    expect.objectContaining({
      artifact_id: 'ART-A',
      path: 'active/shared/artifacts/delivery.json',
      quality_verdict: 'pass',
      delivery_statuses: ['failed'],
    }),
  ]);
  expect(handoff.resume_command.slice(0, 2)).toEqual(['pnpm', 'work']);
  state.awaiting = false;
  await main(handoff.resume_command.slice(2), output);
  expect(JSON.parse(output.mock.lastCall?.[0])).toMatchObject({ next_action: 'reconcile_effect' });
  state.tenant = 'beta';
  await expect(main([...args, '--tenant-slug', 'alpha'], output)).rejects.toThrow('unavailable');
  expect(output).toHaveBeenCalledTimes(2);
  expect(state.artifacts).toHaveBeenCalledTimes(2);
});
