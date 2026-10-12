import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReasoningRoutePolicy,
  ReasoningRouteUserConfig,
  ResolveReasoningRouteInput,
} from './reasoning-route-resolver.js';

const fixture = vi.hoisted(() => ({
  path: '/fixture/reasoning-route-user-config.json',
  files: new Map<string, ReasoningRouteUserConfig>(),
  writes: vi.fn(),
  audit: vi.fn(),
  failPrimary: false,
  failHistory: false,
  locked: false,
  policy: {
    version: 'test',
    runtime_adapters: {
      anthropic: {
        adapter: 'anthropic-sdk',
        capabilities: ['text'],
        supported_parameters: [],
        selection: {
          display_name: 'Anthropic',
          model_provider: 'anthropic',
          availability: { kind: 'env_any', names: ['ANTHROPIC_API_KEY'] },
        },
      },
    },
    profiles: { claude: { mode: 'anthropic', model_ref: 'anthropic:claude-opus-5-5' } },
    roles: { default: { candidates: ['claude'], requires: ['text'] } },
    fallback: { max_attempts: 2, max_in_place_retries: 0, on_unsupported_parameter: 'reject' },
  } as ReasoningRoutePolicy,
}));
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeExistsSync: (path: string) =>
      path.startsWith('/fixture/') ? fixture.files.has(path) : actual.safeExistsSync(path),
    safeUnlinkSync: (path: string) => fixture.files.delete(path),
  };
});
vi.mock('../foundation/json.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../foundation/json.js')>()),
  writeJson: (path: string, value: ReasoningRouteUserConfig) => {
    if (!fixture.locked) throw new Error('write outside config lock');
    if (fixture.failHistory && path.includes('.history/'))
      throw new Error('fixture history write failure');
    fixture.writes(path, value);
    fixture.files.set(path, structuredClone(value));
  },
}));
vi.mock('../governance/governance-action-recorder.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => fixture.audit(...args),
}));
vi.mock('./reasoning-selection-readiness.js', () => ({
  peekReasoningSelectionReadiness: () => ({
    anthropic: { available: true, reason: 'cached fixture' },
  }),
}));
vi.mock('./reasoning-route-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reasoning-route-resolver.js')>();
  return {
    ...actual,
    reasoningRouteUserConfigPath: () => fixture.path,
    loadReasoningRoutePolicy: () => fixture.policy,
    loadReasoningRouteUserConfigAtPath: (path: string) =>
      structuredClone(fixture.files.get(path) ?? {}),
    normalizeReasoningRole: (role?: string) => actual.normalizeReasoningRole(role, fixture.policy),
    resolveReasoningRoute: (input: ResolveReasoningRouteInput = {}) =>
      actual.resolveReasoningRoute({
        ...input,
        policy: fixture.policy,
        env: {},
        brokerPin: null,
        readiness: { anthropic: { available: true, reason: 'cached fixture' } },
      }),
    withReasoningRouteConfigLock: <T>(run: () => T): T => {
      if (fixture.locked) return run();
      fixture.locked = true;
      try {
        return run();
      } finally {
        fixture.locked = false;
      }
    },
    saveReasoningRouteUserConfig: (config: ReasoningRouteUserConfig, expectedRevision: number) => {
      if (!fixture.locked) throw new Error('write outside config lock');
      expect(expectedRevision).toBe(fixture.files.get(fixture.path)?.revision ?? 0);
      if (fixture.failPrimary) throw new Error('fixture primary write failure');
      fixture.writes(fixture.path, config);
      fixture.files.set(fixture.path, structuredClone(config));
    },
  };
});
import {
  commitReasoningRouteConfig,
  getReasoningSelectionSettings,
  previewReasoningSelection,
  rollbackReasoningSelection,
  saveReasoningSelection,
  ReasoningSelectionRevisionConflict,
} from './reasoning-selection-settings.js';

describe('reasoning selection governed settings service', () => {
  beforeEach(() => {
    fixture.files.clear();
    fixture.files.set(fixture.path, { revision: 4, roles: { default: { profile: 'claude' } } });
    fixture.writes.mockClear();
    fixture.audit.mockClear();
    fixture.failPrimary = false;
    fixture.failHistory = false;
    fixture.locked = false;
  });
  it('keeps snapshot/preview pure and omits credentials', () => {
    const result = getReasoningSelectionSettings();
    const preview = previewReasoningSelection({
      role: 'default',
      selection: { mode: 'fixed', runtime_mode: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(result.revision).toBe(4);
    expect(result.roles[0]?.source).toBe('legacy');
    expect(preview.effective?.model).toBe('anthropic:claude-opus-4-8');
    expect(JSON.stringify({ result, preview })).not.toContain('ANTHROPIC_API_KEY');
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
  });
  it('saves one role with CAS, backup, history and verified actor attribution', () => {
    const next = saveReasoningSelection({
      role: 'default',
      expectedRevision: 4,
      actorId: 'verified-operator',
      selection: { mode: 'fixed', runtime_mode: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(next.revision).toBe(5);
    expect(fixture.files.get(fixture.path + '.previous')?.revision).toBe(4);
    expect([...fixture.files.keys()].some((path) => path.includes('.history/'))).toBe(true);
    expect(fixture.audit).toHaveBeenCalledWith(
      'verified-operator',
      'reasoning_route_config_update',
      'select-role:default:revision=5'
    );
  });
  it('rejects stale saves before any backup, state, or audit write', () => {
    expect(() =>
      saveReasoningSelection({
        role: 'default',
        expectedRevision: 3,
        selection: { mode: 'auto' },
      })
    ).toThrow(ReasoningSelectionRevisionConflict);
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
  });
  it('validates the entire proposed config before writing', () => {
    expect(() =>
      saveReasoningSelection({
        role: 'default',
        expectedRevision: 4,
        selection: { mode: 'fixed', runtime_mode: 'anthropic', model: 'unknown-model' },
      })
    ).toThrow();
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.files.get(fixture.path)?.revision).toBe(4);
  });
  it('rolls back content with monotonic current revision and rejects stale rollback', () => {
    saveReasoningSelection({
      role: 'default',
      expectedRevision: 4,
      selection: { mode: 'fixed', runtime_mode: 'anthropic' },
    });
    const restored = rollbackReasoningSelection({
      expectedRevision: 5,
      actorId: 'verified-operator',
    });
    expect(restored.revision).toBe(6);
    expect(fixture.files.get(fixture.path)?.roles?.default?.selection).toBeUndefined();
    expect(fixture.files.get(fixture.path + '.previous')?.revision).toBe(5);
    fixture.writes.mockClear();
    expect(() => rollbackReasoningSelection({ expectedRevision: 5 })).toThrow(
      ReasoningSelectionRevisionConflict
    );
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('dry-run shares validation and does not write or acquire mutating artifacts', () => {
    const next = commitReasoningRouteConfig(
      { revision: 4, roles: { default: { profile: 'claude' } } },
      { expectedRevision: 4, change: 'fixture', dryRun: true }
    );
    expect(next.revision).toBe(5);
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('preserves primary and previous rollback snapshot if primary publication fails', () => {
    const priorBackup = { revision: 2, roles: { default: { profile: 'claude' } } };
    fixture.files.set(fixture.path + '.previous', priorBackup);
    fixture.failPrimary = true;
    expect(() =>
      saveReasoningSelection({
        role: 'default',
        expectedRevision: 4,
        selection: { mode: 'fixed', runtime_mode: 'anthropic' },
      })
    ).toThrow('fixture primary write failure');
    expect(fixture.files.get(fixture.path)?.revision).toBe(4);
    expect(fixture.files.get(fixture.path + '.previous')).toEqual(priorBackup);
    expect(fixture.audit).not.toHaveBeenCalled();
  });
  it('restores the previous rollback snapshot if history publication fails before primary write', () => {
    const priorBackup = { revision: 2, roles: { default: { profile: 'claude' } } };
    fixture.files.set(fixture.path + '.previous', priorBackup);
    fixture.failHistory = true;
    expect(() =>
      saveReasoningSelection({
        role: 'default',
        expectedRevision: 4,
        selection: { mode: 'fixed', runtime_mode: 'anthropic' },
      })
    ).toThrow('fixture history write failure');
    expect(fixture.files.get(fixture.path)?.revision).toBe(4);
    expect(fixture.files.get(fixture.path + '.previous')).toEqual(priorBackup);
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it('does not expose schema or filesystem diagnostics in invalid previews', () => {
    const preview = previewReasoningSelection({ role: 'default', selection: { mode: 'fixed' } });
    expect(preview.valid).toBe(false);
    expect(preview.reason).toBe('Reasoning configuration could not be validated.');
    expect(preview.reason).not.toContain('/fixture/');
    expect(fixture.writes).not.toHaveBeenCalled();
  });
});
