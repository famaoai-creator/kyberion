import { afterEach, describe, expect, it } from 'vitest';

import {
  listVadBackends,
  registerVadBackend,
  resetVadBackendRegistry,
  resolveVadBackend,
} from './vad-registry.js';
import { EnergyVad } from './voice-activity-detector.js';

afterEach(() => {
  resetVadBackendRegistry();
  delete process.env.KYBERION_VAD;
});

describe('vad registry', () => {
  it('resolves the energy backend by default', () => {
    const resolved = resolveVadBackend();
    expect(resolved.backend.backend_id).toBe('energy');
    expect(resolved.degradedFrom).toBeUndefined();
    const vad = resolved.backend.create({ rmsThreshold: 500, endpointMs: 700 });
    expect(vad).toBeInstanceOf(EnergyVad);
  });

  it('honors KYBERION_VAD and degrades on unknown ids with a reason', () => {
    process.env.KYBERION_VAD = 'nonexistent';
    const resolved = resolveVadBackend();
    expect(resolved.backend.backend_id).toBe('energy');
    expect(resolved.degradedFrom).toBe('nonexistent');
    expect(resolved.degradedReason).toMatch(/unknown VAD backend/);
  });

  it('degrades when a registered backend probes unavailable', () => {
    registerVadBackend({
      backend_id: 'flaky',
      needsCalibration: false,
      probe: () => ({ available: false, reason: 'model missing' }),
      create: () => new EnergyVad(),
    });
    const resolved = resolveVadBackend('flaky');
    expect(resolved.backend.backend_id).toBe('energy');
    expect(resolved.degradedReason).toBe('model missing');
  });

  it('uses a registered backend when its probe passes', () => {
    let created = 0;
    registerVadBackend({
      backend_id: 'custom',
      needsCalibration: false,
      probe: () => ({ available: true }),
      create: () => {
        created += 1;
        return new EnergyVad();
      },
    });
    const resolved = resolveVadBackend('custom');
    expect(resolved.backend.backend_id).toBe('custom');
    resolved.backend.create({ rmsThreshold: null, endpointMs: 700 });
    expect(created).toBe(1);
    expect(listVadBackends()).toContain('custom');
  });
});
