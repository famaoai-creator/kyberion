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

  it('resolves static standard-intent pipeline entries through the canonical catalog', async () => {
    const verifyCapabilitySteps = await resolveIntentToSteps('verify-actuator-capability');
    const baselineSteps = await resolveIntentToSteps('check-kyberion-baseline');
    const diagnoseSteps = await resolveIntentToSteps('diagnose-kyberion-system');
    const readinessSteps = await resolveIntentToSteps('verify-environment-readiness');
    const supervisorSteps = await resolveIntentToSteps('inspect-runtime-supervisor');

    expect(verifyCapabilitySteps.length).toBeGreaterThan(0);
    expect(String(verifyCapabilitySteps[0]?.params?.cmd || '')).toContain('pnpm capabilities');

    expect(baselineSteps.length).toBeGreaterThan(0);
    expect(String(baselineSteps[0]?.params?.cmd || '')).toContain('pipelines/baseline-check.json');

    expect(diagnoseSteps.length).toBeGreaterThan(0);
    expect(String(diagnoseSteps[0]?.params?.cmd || '')).toContain('pipelines/system-diagnostics.json');

    expect(readinessSteps.length).toBeGreaterThan(0);
    expect(String(readinessSteps[0]?.params?.cmd || '')).toContain('pipelines/baseline-check.json');

    expect(supervisorSteps.length).toBeGreaterThan(0);
    expect(String(supervisorSteps[0]?.params?.cmd || '')).toContain('agent_runtime_supervisor_status.js');
  });
});
