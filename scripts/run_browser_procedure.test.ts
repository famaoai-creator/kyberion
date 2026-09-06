import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptExitError } from './lib/harness.js';
import { main } from './run_browser_procedure.js';
import type { BrowserExtensionRecording } from '@agent/core/browser-extension-bridge';
import type { ProcedureEntry } from '@agent/core/procedure-types';

const HEX64 = 'a'.repeat(64);

const RECORDING: BrowserExtensionRecording = {
  schema_version: 'browser-recording.v1',
  recording_id: 'rec-001',
  source: 'chrome-extension',
  created_at: '2026-06-24T00:00:00Z',
  tab: { origin: 'https://example.com', origin_hash: HEX64, title: 'Example' },
  extension: { version: '1.0.0' },
  actions: [
    {
      action_id: 'act-1',
      op: 'click_ref',
      summary: 'Continue',
      risk: 'low',
      captured_at: '2026-06-24T00:00:00Z',
      target: {
        ref: '@e1',
        role: 'button',
        name: 'Continue',
        snapshot_hash: HEX64,
      },
    },
  ],
  risk_summary: {
    requires_manual_review: false,
    sensitive_input_omitted: 0,
    approval_required_count: 0,
  },
  review: {
    status: 'approved',
    reviewed_at: '2026-06-24T00:00:01Z',
    decisions: [{ action_id: 'act-1', status: 'approved' }],
  },
};

const PROCEDURE: ProcedureEntry = {
  procedure_id: 'example.click.continue',
  substrate: 'browser',
  adapter: {
    recorder: 'chrome-extension',
    executor: 'extension_session',
    recording_ref: 'active/shared/runtime/recordings/rec-001.json',
  },
  target: { name: 'Example', origins: ['https://example.com'] },
  intent_phrases: ['continue'],
  execution_substrate: 'extension',
  pipeline_ref: 'pipelines/browser/example.click.continue.json',
  risk_class: 'low',
  version: '1.0.0',
  status: 'active',
};

describe('run_browser_procedure', () => {
  const handleAction = vi.fn();
  const dispatch = vi.fn();
  const print = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    handleAction.mockResolvedValue({ status: 'succeeded', results: [] });
    dispatch.mockResolvedValue({ status: 'executed', errors: [], browserResults: [] });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      nodeVersion: 'v24.1.0',
      loadActuator: async () => ({ handleAction }),
      dispatch,
      loadCatalog: () => [PROCEDURE],
      loadRecordingAtPath: () => RECORDING,
      resolveRecordingRef: (ref?: string) => (ref ? `/workspace/${ref.replace(/^\/+/, '')}` : null),
      ...overrides,
    };
  }

  it('prints usage when no run target is given', async () => {
    await expect(main([], print, deps())).rejects.toBeInstanceOf(ScriptExitError);
    expect(String(print.mock.calls[0][0])).toContain('pnpm kyberion browser run');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects Node engines below the documented minimum before loading the actuator', async () => {
    await expect(
      main(['--procedure-id', PROCEDURE.procedure_id], print, deps({ nodeVersion: 'v22.14.0' }))
    ).rejects.toThrow('Node >=24.0.0');
    expect(dispatch).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it('dispatches a catalog procedure on the playwright substrate with an injected executor', async () => {
    await main(['--procedure-id', PROCEDURE.procedure_id], print, deps());
    expect(dispatch).toHaveBeenCalledTimes(1);
    const input = dispatch.mock.calls[0][0];
    expect(input.procedure.procedure_id).toBe(PROCEDURE.procedure_id);
    expect(input.procedure.execution_substrate).toBe('playwright');
    expect(input.recording).toBe(RECORDING);
    expect(typeof input.executeBrowserPipeline).toBe('function');
    const exec = await input.executeBrowserPipeline({
      steps: [{ id: 'step-1', type: 'apply', op: 'click_ref', params: { ref: '@e1' } }],
    });
    expect(exec.status).toBe('succeeded');
    expect(handleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline',
        options: expect.objectContaining({ connect_over_cdp: false, headless: true }),
      })
    );
    expect(print.mock.calls[0][0]).toContain('executed');
  });

  it('rejects non-browser catalog procedures', async () => {
    await expect(
      main(
        ['--procedure-id', 'deal.intake'],
        print,
        deps({
          loadCatalog: () => [{ ...PROCEDURE, procedure_id: 'deal.intake', substrate: 'service' }],
        })
      )
    ).rejects.toThrow('not a browser procedure');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('compiles an allowlisted recording into a playwright procedure before dispatch', async () => {
    await main(['--recording', 'active/shared/runtime/recordings/rec-001.json'], print, deps());
    expect(dispatch).toHaveBeenCalledTimes(1);
    const input = dispatch.mock.calls[0][0];
    expect(input.procedure.execution_substrate).toBe('playwright');
    expect(input.procedure.substrate).toBe('browser');
    expect(input.procedure.target.origins).toContain('https://example.com');
    expect(input.recording.recording_id).toBe('rec-001');
  });

  it('refuses recordings outside the allowlisted stores', async () => {
    await expect(
      main(
        ['--recording', 'libs/actuators/browser-actuator/examples/explore-and-export.json'],
        print,
        deps({ resolveRecordingRef: () => null })
      )
    ).rejects.toThrow('allowlisted');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('exits 2 when the dispatcher requires the same approval gate as the extension path', async () => {
    dispatch.mockResolvedValue({
      status: 'approval_required',
      approvalRequestId: 'REQ-1',
      errors: [],
    });
    await expect(
      main(['--procedure-id', PROCEDURE.procedure_id], print, deps())
    ).rejects.toMatchObject({
      code: 2,
    });
    expect(
      String(print.mock.calls.find((call) => String(call[0]).includes('approval required')))
    ).toContain('REQ-1');
  });

  it('runs hand-authored ADF through handleAction without dispatchProcedure', async () => {
    await main(
      ['--adf', 'libs/actuators/browser-actuator/examples/explore-and-export.json'],
      print,
      deps({
        readAdf: () => ({
          action: 'pipeline',
          steps: [{ type: 'capture', op: 'goto', params: { url: 'https://example.com/' } }],
          options: { headless: true },
        }),
      })
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(handleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline',
        options: expect.objectContaining({ headless: true, connect_over_cdp: false }),
      })
    );
  });

  it('refuses compiled recording drafts on the --adf path so governance is not skipped', async () => {
    await expect(
      main(
        ['--input', 'active/shared/tmp/compiled.json'],
        print,
        deps({
          readAdf: () => ({
            action: 'pipeline',
            _source: { kind: 'browser-recording.v1', recording_id: 'rec-001' },
            steps: [],
          }),
        })
      )
    ).rejects.toThrow('approval gate');
    expect(handleAction).not.toHaveBeenCalled();
  });

  it('surfaces a missing-build error from the host-boundary loader', async () => {
    await expect(
      main(
        ['--procedure-id', PROCEDURE.procedure_id],
        print,
        deps({
          loadActuator: async () => {
            throw new Error(
              'browser-actuator is unavailable. Need Node >=24.0.0 and a built dist/'
            );
          },
        })
      )
    ).rejects.toThrow('built dist/');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
