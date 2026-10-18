import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), report: vi.fn() }));
vi.mock('./continuous_operations_cycle.js', () => ({
  runContinuousOperationsCycleFromRef: mocks.run,
}));
vi.mock('./continuous_operations_report.js', () => ({
  runContinuousOperationsReport: mocks.report,
}));
const { runValidatedSteps } = await import(new URL('./run_pipeline.js', import.meta.url).href);
const report = {
  loop_id: 'loop',
  scope: { tier: 'public', organization_id: 'org' },
  applied: false,
  state_path: '/state',
  inventory: [],
};
const step = (params: Record<string, unknown>) => ({
  id: 'inventory',
  op: 'core:continuous_operations',
  role: 'source' as const,
  params,
  produces: 'inventory_report',
});
describe('core:continuous_operations_report pipeline integration', () => {
  const context = {
    config_ref: 'knowledge/product/governance/continuous-operations/reviewed.json',
    dot_id: 'operator',
    work_item_id: 'work-1',
    attempt_id: 'attempt-1',
    lease_id: 'lease-1',
  };
  const reportStep = {
    id: 'scoped_report',
    op: 'core:continuous_operations_report',
    role: 'source' as const,
    params: { config_ref: '{{config_ref}}' },
    produces: 'artifact_report',
  };
  it('passes the resolved configuration and executor claim to the report and exports its artifact channel', async () => {
    const artifact = {
      artifact_ref: 'ART-CONTOPS-1',
      artifact_path: 'active/shared/artifacts/confidential/acme/report.md',
      scope: { tenant: 'acme', organization: 'ops' },
      observation_count: 4,
    };
    mocks.report.mockResolvedValueOnce(artifact);
    const result = await runValidatedSteps([reportStep], context, { quiet: true });
    expect(result.status).toBe('succeeded');
    expect(mocks.report).toHaveBeenCalledWith(context.config_ref, expect.objectContaining(context));
    expect(result.context.artifact_report).toEqual(artifact);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('propagates a refused ownership check without publishing an artifact channel', async () => {
    mocks.report.mockRejectedValueOnce(new Error('Report executor lease is inactive'));
    const result = await runValidatedSteps([reportStep], context, { quiet: true });
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('Report executor lease is inactive');
    expect(result.context.artifact_report).toBeUndefined();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(report);
});
describe('core:continuous_operations pipeline integration', () => {
  it('resolves configured ref and exports report with preview default', async () => {
    const result = await runValidatedSteps(
      [step({ config_ref: '{{config_ref}}' })],
      { config_ref: 'reviewed.json' },
      { quiet: true }
    );
    expect(result.status).toBe('succeeded');
    expect(mocks.run).toHaveBeenCalledWith('reviewed.json', { apply: false });
    expect(result.context.inventory_report).toEqual(report);
  });
  it('passes explicit apply through without granting admission recovery', async () => {
    const result = await runValidatedSteps(
      [step({ config_ref: 'reviewed.json', apply: true })],
      {},
      { quiet: true }
    );
    expect(result.status).toBe('succeeded');
    expect(mocks.run).toHaveBeenCalledWith('reviewed.json', { apply: true });
  });
  it('rejects a string boolean rather than applying by truthiness', async () => {
    const result = await runValidatedSteps(
      [step({ config_ref: 'reviewed.json', apply: 'true' })],
      {},
      { quiet: true }
    );
    expect(result.status).toBe('failed');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('propagates admission refusal as pipeline failure', async () => {
    mocks.run.mockResolvedValue({
      ...report,
      inventory: [{ disposition: 'error', error: 'refused' }],
    });
    const result = await runValidatedSteps(
      [step({ config_ref: 'reviewed.json', apply: true })],
      {},
      { quiet: true }
    );
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('admission failed');
  });
});
