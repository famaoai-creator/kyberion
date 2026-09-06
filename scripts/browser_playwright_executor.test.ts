import { describe, expect, it, vi } from 'vitest';
import {
  assertSupportedNodeEngine,
  createExecuteBrowserPipeline,
  formatBrowserActuatorUnavailableError,
  loadBrowserActuator,
  REQUIRED_NODE_ENGINE,
} from './browser_playwright_executor.js';

describe('browser_playwright_executor', () => {
  it('rejects Node versions below the documented engine', () => {
    expect(() => assertSupportedNodeEngine('v22.14.0')).toThrow(REQUIRED_NODE_ENGINE);
    expect(() => assertSupportedNodeEngine('v24.0.0')).not.toThrow();
  });

  it('explains missing dist/ and Node engines in the load error', () => {
    const message = formatBrowserActuatorUnavailableError('missing module');
    expect(message).toContain(REQUIRED_NODE_ENGINE);
    expect(message).toContain('pnpm build');
    expect(message).toContain('missing module');
  });

  it('loads handleAction through the injected importer (no static actuator import)', async () => {
    const handleAction = vi.fn();
    const importer = vi.fn().mockResolvedValue({ handleAction });
    const loaded = await loadBrowserActuator(importer);
    expect(loaded.handleAction).toBe(handleAction);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(String(importer.mock.calls[0][0])).toContain(
      'dist/libs/actuators/browser-actuator/src/index.js'
    );
  });

  it('fails closed when the loaded module has no handleAction', async () => {
    await expect(loadBrowserActuator(async () => ({}))).rejects.toThrow(
      'handleAction export missing'
    );
  });

  it('wraps handleAction as the dispatcher executeBrowserPipeline injection', async () => {
    const handleAction = vi.fn().mockResolvedValue({
      status: 'succeeded',
      results: [{ op: 'goto' }],
      context: { evidence: true },
    });
    const execute = createExecuteBrowserPipeline(handleAction, {
      sessionId: 'rec-1',
      headless: true,
      context: { source: 'test' },
    });
    const result = await execute({
      steps: [{ id: 'step-1', type: 'apply', op: 'click_ref', params: { ref: '@e1' } }],
      sessionId: 'tab-9',
      options: { locale: 'ja' },
    });
    expect(result).toEqual({
      status: 'succeeded',
      results: [{ op: 'goto' }],
      errors: undefined,
      context: { evidence: true },
    });
    expect(handleAction).toHaveBeenCalledWith({
      action: 'pipeline',
      steps: [{ id: 'step-1', type: 'apply', op: 'click_ref', params: { ref: '@e1' } }],
      session_id: 'tab-9',
      options: {
        headless: true,
        connect_over_cdp: false,
        record_trace: true,
        record_video: true,
        locale: 'ja',
      },
      context: { source: 'test' },
    });
  });

  it('enables CDP attach only when a CDP endpoint or tab binding is provided', async () => {
    const handleAction = vi.fn().mockResolvedValue({ status: 'success', results: [] });
    const execute = createExecuteBrowserPipeline(handleAction, {
      connectOverCdp: true,
      cdpUrl: 'http://127.0.0.1:9222',
      cdpPort: 9222,
    });
    await execute({ steps: [] });
    expect(handleAction.mock.calls[0][0].options).toMatchObject({
      connect_over_cdp: true,
      cdp_url: 'http://127.0.0.1:9222',
      cdp_port: 9222,
    });
  });

  it('maps non-success actuator status to failed', async () => {
    const execute = createExecuteBrowserPipeline(
      vi.fn().mockResolvedValue({ status: 'failed', errors: ['click_ref failed'] })
    );
    await expect(execute({ steps: [] })).resolves.toEqual({
      status: 'failed',
      results: undefined,
      errors: ['click_ref failed'],
      context: undefined,
    });
  });
});
