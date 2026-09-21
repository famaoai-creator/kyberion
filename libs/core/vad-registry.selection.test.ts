import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: () => undefined,
}));

const { pathResolver } = await import('./path-resolver.js');
const { safeRmSync } = await import('./secure-io.js');
const { setSeamSelectionRule } = await import('./seam-selection-rules.js');
const { registerVadBackend, resetVadBackendRegistry, resolveVadBackend, shouldSelectVadBackend } =
  await import('./vad-registry.js');
const { EnergyVad } = await import('./voice-activity-detector.js');

const dir = pathResolver.sharedTmp('vad-selection-rules-test');
const rulesFile = path.join(dir, 'rules.json');

function fakeBackend(id: string, available: boolean) {
  registerVadBackend({
    backend_id: id,
    needsCalibration: false,
    probe: () => (available ? { available: true } : { available: false, reason: `${id} missing` }),
    create: () => new EnergyVad(),
  });
}

describe('vad backend seam selection', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_VAD', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetVadBackendRegistry();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('keeps energy without a purpose or rule and does not select', () => {
    fakeBackend('silero', true);
    const resolved = resolveVadBackend();
    expect(resolved.backend.backend_id).toBe('energy');
    expect(resolved.decision).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('ranks probed backends by purpose and excludes unavailable ones', () => {
    fakeBackend('silero', true);
    fakeBackend('ten_vad', false);
    const accurate = resolveVadBackend(undefined, { purpose: 'accuracy' });
    expect(accurate.backend.backend_id).toBe('silero');
    expect(accurate.decision?.strategy).toBe('purpose');
    expect(accurate.decision?.excluded).toEqual([{ id: 'ten_vad', unmet: ['ten_vad missing'] }]);
    expect(accurate.decision?.decision_key).toBe('accuracy');
    const light = resolveVadBackend(undefined, { purpose: 'light' });
    expect(light.backend.backend_id).toBe('energy');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'voice.vad-backend/silero' })
    );
  });

  it('lets explicit ids and KYBERION_VAD win over a purpose', () => {
    fakeBackend('silero', true);
    fakeBackend('ten_vad', true);
    expect(resolveVadBackend('energy', { purpose: 'accuracy' }).backend.backend_id).toBe('energy');
    vi.stubEnv('KYBERION_VAD', 'ten_vad');
    const fromEnv = resolveVadBackend(undefined, { purpose: 'light' });
    expect(fromEnv.backend.backend_id).toBe('ten_vad');
    expect(fromEnv.decision).toBeUndefined();
  });

  it('rejects unknown purposes naming the known ones', () => {
    expect(() => resolveVadBackend(undefined, { purpose: 'cheap' })).toThrow(
      /unknown purpose 'cheap'.*known: accuracy, light/
    );
  });

  it('applies an operator rule without a purpose and skips ineligible preferences', () => {
    fakeBackend('silero', false);
    fakeBackend('ten_vad', true);
    setSeamSelectionRule({
      rule_id: 'neural-vad',
      seam: 'voice.vad-backend',
      when: {},
      prefer: ['silero', 'ten_vad'],
      set_by: 'user:test',
    });
    const resolved = resolveVadBackend();
    expect(resolved.backend.backend_id).toBe('ten_vad');
    expect(resolved.decision?.strategy).toBe('rule');
    expect(resolved.decision?.decision_key).toBe('default');
  });

  it('keeps energy without selecting when rules exist but none matches the request', () => {
    fakeBackend('silero', true);
    setSeamSelectionRule({
      rule_id: 'meeting-vad',
      seam: 'voice.vad-backend',
      when: { context: { room: 'meeting' } },
      prefer: ['silero'],
      set_by: 'user:test',
    });
    expect(shouldSelectVadBackend()).toBe(false);
    const quiet = resolveVadBackend();
    expect(quiet.backend.backend_id).toBe('energy');
    expect(quiet.decision).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(shouldSelectVadBackend({ context: { room: 'meeting' } })).toBe(true);
    expect(resolveVadBackend(undefined, { context: { room: 'meeting' } }).backend.backend_id).toBe(
      'silero'
    );
  });
});
