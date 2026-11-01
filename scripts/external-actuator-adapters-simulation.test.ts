/** Real governance and storage; only browser/device/git wire transports are simulated. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeWriteFile } from '@agent/core/secure-io';
import { rootResolve } from '@agent/core/path-resolver';
import type { Page } from '@playwright/test';
import { withExternalOperationAuthority } from '@agent/core/governance/external-operation';
import { resolveScopeContext } from '@agent/core/scope-context';
import { gitPush, type VcsCommandRunner } from '@agent/core/vcs/git';
import {
  opApply,
  type BrowserRuntime,
} from '../libs/actuators/browser-actuator/src/browser-pipeline-helpers.js';
import { createBrowserWatchdog } from '../libs/actuators/browser-actuator/src/browser-watchdog.js';
import {
  registerVoicePlaybackPlatformAdapter,
  resolveVoicePlaybackPlatformAdapter,
} from '../libs/actuators/voice-actuator/src/voice-runtime-helpers.js';
import {
  simulationAuthority,
  captureSimulationApproval,
  approveSimulationRequest,
  cleanupSimulationApprovals,
} from '../tests/helpers/external-actuator-simulation.js';

const observations: Array<Record<string, unknown>> = [];
afterAll(() => {
  const report = `active/shared/tmp/external-actuator-simulation/${randomUUID()}/adapters-report.json`;
  safeWriteFile(
    rootResolve(report),
    JSON.stringify(
      {
        simulation: true,
        real_governance_and_storage: true,
        mocked_boundary: 'browser page, voice device adapter, VCS command runner',
        cases: observations,
      },
      null,
      2
    )
  );
  process.stdout.write(`SIMULATION_REPORT ${report}\n`);
  cleanupSimulationApprovals();
  vi.unstubAllEnvs();
});

beforeAll(() => {
  vi.stubEnv('KYBERION_ALLOW_TEST_NOTIFICATIONS', '0');
  vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
});

describe('external adapters with real approval persistence simulation', () => {
  it('browser click: pending -> approved -> exactly one click; replay stops', async () => {
    const click = vi.fn(async () => undefined);
    const page = { url: () => 'https://example.com/form', click } as unknown as Page;
    const runtime: BrowserRuntime = {
      tabs: new Map([['simulation-tab', page]]),
      activeTabId: 'simulation-tab',
      context: {} as BrowserRuntime['context'],
      pageIds: new WeakMap(),
      cdpSessions: new WeakMap(),
      watchdog: createBrowserWatchdog(),
      consoleEvents: [],
      networkEvents: [],
      navigationPolicy: { allowed_origins: ['https://example.com'] },
    };
    const authority = simulationAuthority('browser', resolveScopeContext().tenant_slug);
    const execute = () =>
      withExternalOperationAuthority(
        () => authority,
        () => opApply('click', { selector: '#submit' }, runtime, {}, (value: unknown) => value)
      );
    const request = await captureSimulationApproval(execute);
    expect(request.status).toBe('pending');
    expect(click).not.toHaveBeenCalled();
    expect(approveSimulationRequest(request).status).toBe('approved');
    await execute();
    expect(click).toHaveBeenCalledTimes(1);
    await expect(execute()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(click).toHaveBeenCalledTimes(1);
    observations.push({
      operation: 'browser:click',
      request_id: request.id,
      before_approval: 0,
      after_approval: 1,
      after_replay: 1,
    });
  });

  it('voice registered speech: pending -> approved -> one audible attempt; ambiguous failure cannot replay', async () => {
    const transport = vi.fn(() => {
      throw new Error('simulated device acknowledgement lost');
    });
    const unregister = registerVoicePlaybackPlatformAdapter('simulation-speaker', {
      speak: transport,
    });
    try {
      const adapter = resolveVoicePlaybackPlatformAdapter('simulation-speaker');
      const authority = simulationAuthority('voice');
      const execute = () =>
        withExternalOperationAuthority(
          () => authority,
          () => adapter.speak!('Simulation announcement', 100)
        );
      const request = await captureSimulationApproval(execute);
      expect(transport).not.toHaveBeenCalled();
      approveSimulationRequest(request);
      await expect(execute()).rejects.toThrow('EXTERNAL_RESULT_UNVERIFIED');
      await expect(execute()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
      expect(transport).toHaveBeenCalledTimes(1);
      observations.push({
        operation: 'voice:speak',
        request_id: request.id,
        before_approval: 0,
        after_approval: 1,
        outcome: 'unknown',
        after_replay: 1,
      });
    } finally {
      unregister();
    }
  });

  it('VCS canonical push: approval binds URL and SHA; transport sends once', async () => {
    const sent: string[][] = [];
    const sha = 'a'.repeat(40);
    const remote = 'https://github.com/simulation/example.git';
    const runner: VcsCommandRunner = (_bin, args) => {
      if (args[0] === 'push') sent.push([...args]);
      return {
        status: 0,
        stdout:
          args[0] === 'remote'
            ? remote
            : args[0] === 'rev-parse'
              ? sha
              : args[0] === 'symbolic-ref'
                ? 'feature'
                : '',
        stderr: '',
      };
    };
    const authority = simulationAuthority('vcs');
    const execute = () =>
      withExternalOperationAuthority(
        () => authority,
        () => gitPush('.', { ref: 'feature' }, runner)
      );
    const request = await captureSimulationApproval(execute);
    expect(sent).toEqual([]);
    approveSimulationRequest(request);
    execute();
    expect(sent).toEqual([['push', '--', remote, `${sha}:refs/heads/feature`]]);
    expect(execute).toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(sent).toHaveLength(1);
    observations.push({
      operation: 'vcs:push',
      request_id: request.id,
      before_approval: 0,
      after_approval: 1,
      after_replay: 1,
      approved_sha: sha,
    });
  });

  it('VCS refuses a changed commit after review without sending it', async () => {
    let sha = 'b'.repeat(40);
    const sent = vi.fn();
    const runner: VcsCommandRunner = (_bin, args) => {
      if (args[0] === 'push') sent();
      return {
        status: 0,
        stdout:
          args[0] === 'remote'
            ? 'https://github.com/simulation/example.git'
            : args[0] === 'rev-parse'
              ? sha
              : 'feature',
        stderr: '',
      };
    };
    const authority = simulationAuthority('vcs-drift');
    const execute = () =>
      withExternalOperationAuthority(
        () => authority,
        () => gitPush('.', { ref: 'feature' }, runner)
      );
    const request = await captureSimulationApproval(execute);
    approveSimulationRequest(request);
    sha = 'c'.repeat(40);
    expect(execute).toThrow('effect_mismatch');
    expect(sent).not.toHaveBeenCalled();
    observations.push({
      operation: 'vcs:push',
      request_id: request.id,
      outcome: 'effect_mismatch',
      transport_calls: 0,
    });
  });
});
