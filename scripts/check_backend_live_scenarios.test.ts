import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The script must never build a backend (or spend a model turn) unless it is
// told to with --live and an explicit --mode list. Every seam that could reach
// a provider or the runtime store is mocked and asserted untouched.
const mocks = vi.hoisted(() => ({
  buildTaskReasoningBackend: vi.fn(),
  runBackendLiveScenarios: vi.fn(),
  recordBackendLiveScenarioRun: vi.fn(),
}));

vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  buildTaskReasoningBackend: mocks.buildTaskReasoningBackend,
}));

vi.mock('@agent/core/backend-live-scenarios', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/backend-live-scenarios')>()),
  runBackendLiveScenarios: mocks.runBackendLiveScenarios,
  recordBackendLiveScenarioRun: mocks.recordBackendLiveScenarioRun,
}));

import { BACKEND_LIVE_TURN_TIMEOUT_MS } from '@agent/core/backend-live-scenarios';
import { runCheckBackendLiveScenarios } from './check_backend_live_scenarios.js';

describe('check:backend-live-scenarios entrypoint', () => {
  let output: string[];
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    output = [];
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
      output.push(String(value));
    });
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      output.push(String(value));
    });
    mocks.buildTaskReasoningBackend.mockReset();
    mocks.runBackendLiveScenarios.mockReset();
    mocks.recordBackendLiveScenarioRun.mockReset();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it('prints the plan and the cost warning without building any backend', async () => {
    const result = await runCheckBackendLiveScenarios(['--mode', 'claude-cli', '--model', 'm-1']);
    expect(result).toMatchObject({ live: false, modes: ['claude-cli'] });
    const text = output.join('\n');
    expect(text).toContain('claude-cli  model=m-1');
    expect(text).toMatch(/spend real model turns/u);
    expect(text).toMatch(/Dry plan only/u);
    expect(mocks.buildTaskReasoningBackend).not.toHaveBeenCalled();
    expect(mocks.runBackendLiveScenarios).not.toHaveBeenCalled();
    expect(mocks.recordBackendLiveScenarioRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses --live without an explicit --mode list (exit 2) and builds nothing', async () => {
    await runCheckBackendLiveScenarios(['--live']);
    expect(process.exitCode).toBe(2);
    expect(output.join('\n')).toMatch(/--live requires an explicit --mode list/u);
    expect(mocks.buildTaskReasoningBackend).not.toHaveBeenCalled();
    expect(mocks.runBackendLiveScenarios).not.toHaveBeenCalled();
  });

  it('drives the provider without the route request wrapper on a live run', async () => {
    const backend = { name: 'stub-live' };
    mocks.buildTaskReasoningBackend.mockReturnValue(backend);
    mocks.runBackendLiveScenarios.mockResolvedValue({
      version: '1.0.0',
      run_id: 'r',
      mode: 'claude-cli',
      backend_name: 'stub-live',
      served_model: 'unreported',
      started_at: 'a',
      finished_at: 'b',
      scenarios: [],
    });
    mocks.recordBackendLiveScenarioRun.mockReturnValue('/tmp/r.json');
    await runCheckBackendLiveScenarios(['--live', '--mode', 'claude-cli']);
    // The wrapper would answer an abort for the provider and cap turns at the
    // route's 60s limit; the scenarios bound every call themselves.
    expect(mocks.buildTaskReasoningBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'claude-cli',
        requestTimeout: 'caller',
        timeoutMs: BACKEND_LIVE_TURN_TIMEOUT_MS,
      })
    );
    expect(mocks.runBackendLiveScenarios).toHaveBeenCalledWith(
      backend,
      // A CLI backend's abort must show its child process exited.
      expect.objectContaining({
        turnTimeoutMs: BACKEND_LIVE_TURN_TIMEOUT_MS,
        requireChildExit: true,
      })
    );
  });

  it('does not require a child exit from a backend with no child process', async () => {
    mocks.buildTaskReasoningBackend.mockReturnValue({ name: 'api-live' });
    mocks.runBackendLiveScenarios.mockResolvedValue({
      version: '1.0.0',
      run_id: 'r',
      mode: 'anthropic',
      backend_name: 'api-live',
      served_model: 'unreported',
      started_at: 'a',
      finished_at: 'b',
      scenarios: [],
    });
    mocks.recordBackendLiveScenarioRun.mockReturnValue('/tmp/r.json');
    await runCheckBackendLiveScenarios(['--live', '--mode', 'anthropic']);
    expect(mocks.buildTaskReasoningBackend).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'anthropic', requestTimeout: 'caller' })
    );
    expect(mocks.runBackendLiveScenarios).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireChildExit: false })
    );
  });

  it('rejects an unknown flag before doing anything', async () => {
    await runCheckBackendLiveScenarios(['--live', '--mode', 'claude-cli', '--bogus']);
    expect(process.exitCode).toBe(2);
    expect(mocks.buildTaskReasoningBackend).not.toHaveBeenCalled();
  });
});
