import { externalApprovalFixture } from '../../../tests/helpers/external-approval-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  service: vi.fn(),
  audit: vi.fn(),
  reserve: vi.fn(),
  write: vi.fn(),
  referenceBytes: 'reviewed-image',
}));
vi.mock('../governance/approval-gate.js', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('../governance/external-operation-store.js', () => ({
  reserveExternalOperation: mocks.reserve,
}));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => undefined }));
vi.mock('../service/service-engine.js', () => ({ executeServicePreset: mocks.service }));
vi.mock('../secure-io.js', async (original) => {
  const actual = await original<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeWriteFile: mocks.write,
    safeReadFile: (...args: Parameters<typeof actual.safeReadFile>) =>
      String(args[0]).endsWith('/image-reference.png')
        ? Buffer.from(mocks.referenceBytes)
        : actual.safeReadFile(...args),
  };
});
import {
  AdaptivePolicyRouter,
  GeminiFastImageGenerationProvider,
  ImageGenerationProvider,
  registerImageGenerationProvider,
  listImageGenerationProviders,
} from './image-generation-bridge.js';
import {
  withExternalOperationAuthority,
  withExternalOperationApprovalObserver,
} from '../governance/external-operation.js';

function provider(id = 'gemini_fast', local = false): ImageGenerationProvider {
  return {
    id,
    executionLocality: local ? 'local' : 'remote',
    costTier: 'free',
    isAvailable: async () => true,
    generate: vi.fn(async () => ({
      status: 'succeeded' as const,
      path: 'active/shared/tmp/mock-image.png',
      provider: id,
      elapsedMs: 1,
    })),
  };
}

describe('image generation external boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.referenceBytes = 'reviewed-image';
    mocks.gate.mockReturnValue({ allowed: false, status: 'pending', message: 'human required' });
    mocks.service.mockResolvedValue({ imageBytes: Buffer.from('image').toString('base64') });
  });

  it('gates direct native cloud instances before the actual service call', async () => {
    await expect(
      new GeminiFastImageGenerationProvider().generate({ prompt: 'private prompt' })
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('does not treat JSON authority as a trusted grant', async () => {
    const remote = provider();
    await expect(
      new AdaptivePolicyRouter([remote]).generateWithFallback({
        prompt: 'private',
        hasHuman: true,
        authority: { hasHuman: true },
      } as never)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(remote.generate).not.toHaveBeenCalled();
    expect(mocks.gate).toHaveBeenCalledWith(expect.objectContaining({ hasHuman: false }));
  });

  it('protects direct handles retrieved from the custom provider registry', async () => {
    const remote = provider('test-governed-image');
    const dispose = registerImageGenerationProvider(remote);
    try {
      const handle = listImageGenerationProviders().find((p) => p.id === remote.id)!;
      await expect(handle.generate({ prompt: 'private' })).rejects.toThrow(
        'EXTERNAL_APPROVAL_REQUIRED'
      );
      expect(remote.generate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('retains automatic local rendering', async () => {
    const local = provider('local_flux', true);
    const result = await new AdaptivePolicyRouter([local]).generateWithFallback({
      prompt: 'local',
    });
    expect(result.status).toBe('succeeded');
    expect(local.generate).toHaveBeenCalledTimes(1);
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('records a failed remote receipt as unknown and does not try another provider', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    const first = provider();
    vi.mocked(first.generate).mockResolvedValue({
      status: 'failed',
      provider: first.id,
      elapsedMs: 1,
      error: '429 response lost',
    });
    const second = provider('gemini_service');
    const observer = vi.fn();
    const result = await withExternalOperationApprovalObserver(observer, () =>
      new AdaptivePolicyRouter([first, second]).generateWithFallback({
        prompt: 'one',
        providerPreference: [first.id, second.id],
      })
    );
    expect(result.status).toBe('failed');
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(second.generate).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('keeps consent independent of common admission', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    await expect(
      new GeminiFastImageGenerationProvider().generate({
        prompt: 'one',
        referenceImages: [{ path: 'active/shared/tmp/private.png', mimeType: 'image/png' }],
      })
    ).rejects.toThrow();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('binds reference content and rejects a change during approval before calling the provider', async () => {
    const remote = { ...provider(), supportsReferenceImages: true };
    mocks.gate.mockImplementation(() => {
      mocks.referenceBytes = 'replaced-image';
      return { allowed: true, status: 'approved', requestId: 'exact-fixture-approval' };
    });
    await expect(
      new AdaptivePolicyRouter([remote]).generateWithFallback({
        prompt: 'one',
        referenceImages: [{ path: 'active/shared/tmp/image-reference.png', mimeType: 'image/png' }],
        egressConsent: {
          subject: 'user_photo',
          provider_id: remote.id,
          provider_class: 'cloud',
          granted_at: new Date().toISOString(),
          granted_by: 'user:owner',
        },
      })
    ).rejects.toThrow('IMAGE_REFERENCE_CHANGED');
    expect(remote.generate).not.toHaveBeenCalled();
  });

  it('preserves a stable invocation and blocks replay before a second call', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    const seen = new Set<string>();
    mocks.reserve.mockImplementation(({ invocationId }) => {
      if (seen.has(invocationId)) throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
      seen.add(invocationId);
    });
    const remote = provider();
    const router = new AdaptivePolicyRouter([remote]);
    await withExternalOperationAuthority(
      () => ({ agentId: 'image-test', invocationId: 'one-image' }),
      async () => {
        await router.generateWithFallback({ prompt: 'one' });
        await expect(router.generateWithFallback({ prompt: 'changed' })).rejects.toThrow(
          'EXTERNAL_EXECUTION_ALREADY_RESERVED'
        );
      }
    );
    expect(remote.generate).toHaveBeenCalledTimes(1);
    mocks.reserve.mockReset();
  });
});

vi.mock('../governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store.js')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = mocks.gate.mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
