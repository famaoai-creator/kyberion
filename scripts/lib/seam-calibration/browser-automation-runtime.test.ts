import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleAction = vi.fn();
vi.mock('../../browser_playwright_executor.js', () => ({
  loadBrowserActuator: vi.fn().mockResolvedValue({ handleAction }),
}));

// Real runtime registration (side effect), mirroring
// libs/actuators/browser-actuator/src/browser-runtime-selection.test.ts, so
// listBrowserAutomationRuntimeBridges() sees both playwright-chromium and
// lightpanda without loading the (mocked) actuator entrypoint for that.
await import('../../../libs/actuators/browser-actuator/src/browser-automation-runtime-playwright.js');
await import('../../../libs/actuators/browser-actuator/src/browser-automation-runtime-lightpanda.js');

const {
  browserAutomationRuntimeCalibrationAdapter,
  resetBrowserAutomationRuntimeCalibrationActuatorForTest,
} = await import('./browser-automation-runtime.js');

const READ_ONLY = [
  { type: 'capture', op: 'goto', params: { url: 'https://example.com/' } },
  { type: 'capture', op: 'distill_dom', params: {} },
];
const WITH_SCREENSHOT = [...READ_ONLY, { type: 'capture', op: 'screenshot', params: {} }];

describe('browser-automation-runtime calibration adapter', () => {
  beforeEach(() => {
    handleAction.mockReset();
    resetBrowserAutomationRuntimeCalibrationActuatorForTest();
  });
  afterEach(() => vi.clearAllMocks());

  it('declares the speed trait mapping', () => {
    expect(browserAutomationRuntimeCalibrationAdapter.trait_mappings).toEqual({
      speed: { metric: 'latency_ms', higher_is_better: false },
    });
  });

  it('lists both runtimes eligible for a read-only pipeline', async () => {
    const candidates = await browserAutomationRuntimeCalibrationAdapter.listCandidates({
      steps: READ_ONLY,
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        { id: 'playwright-chromium', eligible: true, unmet: [] },
        { id: 'lightpanda', eligible: true, unmet: [] },
      ])
    );
  });

  it('marks lightpanda ineligible for a pipeline needing pixel screenshots', async () => {
    const candidates = await browserAutomationRuntimeCalibrationAdapter.listCandidates({
      steps: WITH_SCREENSHOT,
    });
    const lightpanda = candidates.find((c) => c.id === 'lightpanda');
    expect(lightpanda?.eligible).toBe(false);
    expect(lightpanda?.unmet).toEqual(['screenshot (pixel_screenshots)']);
  });

  it('runs a trial by forcing browser_runtime and a fresh, non-persistent session', async () => {
    handleAction.mockResolvedValueOnce({ status: 'succeeded', results: [] });

    const result = await browserAutomationRuntimeCalibrationAdapter.runTrial(
      'lightpanda',
      { steps: READ_ONLY },
      { outDir: 'active/shared/tmp/browser-runtime-calibration-test', repeat: 0 }
    );

    expect(result).toEqual({ ok: true, metrics: { success: 1 } });
    expect(handleAction).toHaveBeenCalledTimes(1);
    const call = handleAction.mock.calls[0]![0];
    expect(call.action).toBe('pipeline');
    expect(call.steps).toBe(READ_ONLY);
    expect(call.options.browser_runtime).toBe('lightpanda');
    expect(call.options.keep_alive).toBe(false);
    expect(String(call.session_id)).toMatch(/^seam-calibration--lightpanda--/);
  });

  it('reports a failed trial with the actuator error, without throwing', async () => {
    handleAction.mockResolvedValueOnce({ status: 'failed', errors: ['boom'] });

    const result = await browserAutomationRuntimeCalibrationAdapter.runTrial(
      'playwright-chromium',
      { steps: READ_ONLY },
      { outDir: 'active/shared/tmp/browser-runtime-calibration-test', repeat: 0 }
    );

    expect(result).toEqual({ ok: false, error: 'boom', metrics: { success: 0 } });
  });

  it('catches a rejected actuator call as a failed trial', async () => {
    handleAction.mockRejectedValueOnce(new Error('actuator exploded'));

    const result = await browserAutomationRuntimeCalibrationAdapter.runTrial(
      'playwright-chromium',
      { steps: READ_ONLY },
      { outDir: 'active/shared/tmp/browser-runtime-calibration-test', repeat: 0 }
    );

    expect(result).toEqual({ ok: false, error: 'actuator exploded' });
  });

  it('generates a unique session id per call', async () => {
    handleAction.mockResolvedValue({ status: 'succeeded' });
    await browserAutomationRuntimeCalibrationAdapter.runTrial(
      'lightpanda',
      { steps: READ_ONLY },
      { outDir: 'active/shared/tmp/browser-runtime-calibration-test', repeat: 0 }
    );
    await browserAutomationRuntimeCalibrationAdapter.runTrial(
      'lightpanda',
      { steps: READ_ONLY },
      { outDir: 'active/shared/tmp/browser-runtime-calibration-test', repeat: 1 }
    );
    const first = handleAction.mock.calls[0]![0].session_id;
    const second = handleAction.mock.calls[1]![0].session_id;
    expect(first).not.toBe(second);
  });
});
