import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import { bindFixedReasoningBackend, hasFixedReasoningBinding } from './reasoning-fixed-binding.js';
import { currentScope, resetCurrentScope } from '../scope-context.js';
import * as scopeEnvelope from '../scope-envelope.js';
import {
  loadReasoningRouteUserConfig,
  resolveReasoningRoute,
  type ResolvedReasoningRoute,
} from './reasoning-route-resolver.js';

vi.mock('./reasoning-route-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reasoning-route-resolver.js')>()),
  loadReasoningRouteUserConfig: vi.fn(),
  resolveReasoningRoute: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  resetCurrentScope();
});

const route = {
  role: 'implementer',
  mode: 'codex-cli',
  model: 'pinned-model',
  profileRef: 'fixed-test',
  selection: { requested: { mode: 'fixed' }, modelPinned: true },
} as unknown as ResolvedReasoningRoute;

describe('fixed task routing scope', () => {
  it('dispatches through the pinned text route using the active task envelope instead of ambient cache', async () => {
    vi.stubEnv('KYBERION_TENANT', undefined);
    vi.stubEnv('KYBERION_TIER', 'public');
    currentScope();
    const identity = {
      tier: 'confidential' as const,
      tenant_slug: 'alpha',
      mission_id: 'MSN-TASK-SCOPE',
      task_id: 'TASK-A',
    };
    vi.spyOn(scopeEnvelope, 'currentScopeEnvelope').mockReturnValue({
      identity,
      policy: { read_tiers: ['confidential'], write_tier: 'confidential', purpose: 'task' },
      minted_at: '2026-10-30T00:00:00Z',
      mint_ref: 'test-only',
    });
    vi.mocked(loadReasoningRouteUserConfig).mockReturnValue({
      roles: { implementer: { selection: { mode: 'fixed' } } },
    } as ReturnType<typeof loadReasoningRouteUserConfig>);
    vi.mocked(resolveReasoningRoute).mockImplementation((input) => {
      expect(input?.scope).toBe(identity);
      return route;
    });
    const delegateTask = vi.fn(async () => 'pinned response');
    const backend = bindFixedReasoningBackend(
      { name: 'fixed-text', delegateTask } as unknown as ReasoningBackend,
      route,
      { nativeAdoption: 'disabled' }
    );
    expect(hasFixedReasoningBinding(backend)).toBe(true);
    expect(backend.getNativeSubagentAdopter).toBeUndefined();
    await expect(
      backend.delegateTask('hello', 'task-context', { role: 'implementer', model: 'pinned-model' })
    ).resolves.toBe('pinned response');
    expect(delegateTask).toHaveBeenCalledWith(
      'hello',
      'task-context',
      expect.objectContaining({ model: 'pinned-model' })
    );
    vi.mocked(resolveReasoningRoute).mockReturnValue({ ...route, mode: 'grok-api' });
    expect(() => backend.delegateTask('changed pin')).toThrow('active backend conflicts');
    expect(delegateTask).toHaveBeenCalledTimes(1);
  });
});
