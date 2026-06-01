import { describe, expect, it } from 'vitest';
import { resolveIntentToSteps } from './resolver.js';

describe('super-nerve resolver stop-service flow', () => {
  it('lists running services when no target service is specified', async () => {
    const steps = await resolveIntentToSteps('サービスを停止して');

    expect(steps).toHaveLength(1);
    expect(steps[0]?.op).toBe('system:shell');
    expect(String(steps[0]?.params?.cmd || '')).toContain('service_lifecycle_control.js');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--operation list');
    expect(String(steps[0]?.params?.cmd || '')).not.toContain('voice-hub');
  });

  it('stops the selected service when the utterance names one explicitly', async () => {
    const steps = await resolveIntentToSteps('voice-hub を停止して');

    expect(steps).toHaveLength(1);
    expect(steps[0]?.op).toBe('system:shell');
    expect(String(steps[0]?.params?.cmd || '')).toContain('service_lifecycle_control.js');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--operation stop');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--service-name voice-hub');
  });

  it('lists startable services when no target service is specified', async () => {
    const steps = await resolveIntentToSteps('サービスを起動して');

    expect(steps).toHaveLength(1);
    expect(steps[0]?.op).toBe('system:shell');
    expect(String(steps[0]?.params?.cmd || '')).toContain('service_lifecycle_control.js');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--operation start');
    expect(String(steps[0]?.params?.cmd || '')).not.toContain('voice-hub');
  });

  it('starts the selected service when the utterance names one explicitly', async () => {
    const steps = await resolveIntentToSteps('voice-hub を起動して');

    expect(steps).toHaveLength(1);
    expect(steps[0]?.op).toBe('system:shell');
    expect(String(steps[0]?.params?.cmd || '')).toContain('service_lifecycle_control.js');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--operation start');
    expect(String(steps[0]?.params?.cmd || '')).toContain('--service-name voice-hub');
  });
});
