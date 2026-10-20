import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  audit: vi.fn(),
  reserve: vi.fn(),
  fetch: vi.fn(),
  service: vi.fn(),
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: mocks.reserve,
}));
vi.mock('@agent/core/network', async (original) => ({
  ...(await original<typeof import('@agent/core/network')>()),
  secureFetch: mocks.fetch,
}));
vi.mock('@agent/core/service/service-engine', () => ({ executeServicePreset: mocks.service }));
vi.mock('@agent/core/actuator/actuator-trace', () => ({
  createActuatorTrace: () => ({ startSpan: vi.fn(), endSpan: vi.fn() }),
  finalizeActuatorTrace: () => ({}),
}));
import {
  createVideoGenerationProvider,
  resolveVideoGenerationBackend,
  normalizeVideoGenerationRequest,
  executeDirectVideoGeneration,
} from './video-generation-provider.js';
import { executePreparedGeneration } from './media-generation-helpers.js';
import { handleAction } from './media-generation-action-helpers.js';
import {
  withExternalOperationApprovalObserver,
  withExternalOperationPipelineRun,
} from '@agent/core/governance/external-operation';

describe('external generation admission and replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockReturnValue({ allowed: false, status: 'pending', message: 'human required' });
    vi.stubEnv('KYBERION_RUNWAY_API_KEY', 'fixture-key');
  });
  afterEach(() => vi.unstubAllEnvs());

  const runway = () => {
    const backend = resolveVideoGenerationBackend({ backend_id: 'media-generation.runway.gen4.5' });
    return {
      provider: createVideoGenerationProvider(backend),
      request: normalizeVideoGenerationRequest({ prompt: 'one video' }, backend),
    };
  };

  it('blocks direct video provider submit before any request', async () => {
    const { provider, request } = runway();
    await expect(provider.submit(request)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('records accepted submission, not final rendering completion', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.fetch.mockResolvedValue({ id: 'video-task-1' });
    const { provider, request } = runway();
    const result = await provider.submit(request);
    expect(result.status).toBe('submitted');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it('stops after an attempted video send with no retry', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.fetch.mockRejectedValue(new Error('response lost'));
    const { provider, request } = runway();
    const observer = vi.fn();
    await withExternalOperationApprovalObserver(observer, () =>
      expect(provider.submit(request)).rejects.toMatchObject({ adfControlFlow: 'preflight' })
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('stops model repair after a successful submit followed by failed polling', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.fetch
      .mockResolvedValueOnce({ id: 'video-task-1' })
      .mockRejectedValueOnce(new Error('status response lost'));
    const observer = vi.fn();
    await withExternalOperationApprovalObserver(observer, () =>
      expect(
        executeDirectVideoGeneration({
          backend_id: 'media-generation.runway.gen4.5',
          prompt: 'one video',
          await_completion: true,
        })
      ).rejects.toMatchObject({ adfControlFlow: 'preflight' })
    );
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('gates service-backed workflow submission at its direct helper boundary', async () => {
    await expect(
      executePreparedGeneration('generate_image', {
        action: 'generate_image',
        params: {},
        workflow: { graph: 'fixture' },
      })
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('keeps workflow request outcome unknown when no receipt id exists', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'approved' });
    mocks.service.mockResolvedValue({ message: 'maybe accepted' });
    const observer = vi.fn();
    await withExternalOperationApprovalObserver(observer, () =>
      executePreparedGeneration('generate_image', {
        action: 'generate_image',
        params: {},
        workflow: { graph: 'fixture' },
      })
    );
    expect(mocks.service).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('refuses resumable inner batches before the first provider call', async () => {
    await expect(
      withExternalOperationPipelineRun('run', () =>
        handleAction({
          action: 'pipeline',
          steps: [
            { action: 'generate_image', params: { prompt: 'one' } },
            { action: 'generate_video', params: { prompt: 'two' } },
          ],
        })
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
