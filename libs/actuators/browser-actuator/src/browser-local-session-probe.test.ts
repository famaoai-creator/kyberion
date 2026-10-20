import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => {
  const page = {
    setContent: vi.fn(async () => undefined),
    title: vi.fn(async () => 'Kyberion First Win'),
    url: vi.fn(() => 'about:blank'),
    innerText: vi.fn(async () => 'Kyberion First Win'),
    screenshot: vi.fn(async () => Buffer.from('synthetic screenshot')),
  };
  const context = { route: vi.fn(), newPage: vi.fn(async () => page), close: vi.fn() };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
  return { page, context, browser, launch: vi.fn(async () => browser) };
});
vi.mock('@playwright/test', () => ({ chromium: { launch: mocks.launch } }));

import { executePipeline } from './browser-pipeline-helpers.js';
import { actuator } from './index.js';
const scratch = `active/shared/tmp/local-probe-test-${randomUUID()}`;

describe('isolated local browser session probe', () => {
  beforeEach(() => vi.clearAllMocks());
  afterAll(() => safeRmSync(scratch, { recursive: true, force: true }));

  it('accepts exactly the runner metadata through the actual catalog SDK dispatch', async () => {
    const result = await actuator.dispatch(
      'local_session_probe',
      {
        path: `${scratch}/compiled-probe.png`,
        export_as: 'first_win_screenshot',
        _reasoning_policy: {},
        _facets: undefined,
        _step_id: 'verify-local-session',
      },
      {}
    );
    expect(result.ok).toBe(true);
    expect(mocks.page.screenshot).toHaveBeenCalledWith({ type: 'png' });
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it('captures fixed local content without authority, profile reuse, or caller script', async () => {
    const result = await executePipeline(
      [
        {
          type: 'capture',
          op: 'local_session_probe',
          params: { path: `${scratch}/probe.png`, export_as: 'first_win_screenshot' },
        },
      ],
      'local-probe',
      { keep_alive: true, cdp_url: 'http://unsafe.invalid', user_data_dir: 'private-profile' }
    );
    expect(result.status).toBe('success');
    expect(result.context.session_state.title).toBe('Kyberion First Win');
    expect(mocks.launch).toHaveBeenCalledWith({ headless: true });
    expect(mocks.browser.newContext).toHaveBeenCalledWith({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const [pattern, abortRoute] = mocks.context.route.mock.calls[0] as unknown as [
      string,
      (route: { abort: () => Promise<void> }) => Promise<void>,
    ];
    expect(pattern).toBe('**/*');
    const abort = vi.fn(async () => undefined);
    await abortRoute({ abort });
    expect(abort).toHaveBeenCalledOnce();
    expect(mocks.page.setContent).toHaveBeenCalledWith(
      expect.stringContaining('Kyberion First Win')
    );
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
    expect(mocks.page.screenshot).toHaveBeenCalledWith({ type: 'png' });
  });

  it.each([
    { params: { script: 'fetch("https://unsafe.invalid")' }, context: {} },
    { params: { url: 'https://unsafe.invalid' }, context: {} },
    { params: {}, context: { TARGET_URL: 'https://unsafe.invalid' } },
  ])(
    'rejects caller content and legacy remote target before launch: %j',
    async ({ params, context }) => {
      await expect(
        executePipeline(
          [{ type: 'capture', op: 'local_session_probe', params }],
          'local-probe',
          {},
          context
        )
      ).rejects.toThrow('BROWSER_LOCAL_PROBE');
      expect(mocks.launch).not.toHaveBeenCalled();
    }
  );

  it('rejects existing repository assets and symlink leaves before launch', async () => {
    await expect(
      executePipeline(
        [
          {
            type: 'capture',
            op: 'local_session_probe',
            params: {
              path: 'presence/displays/concierge/public/icons/icon-512.png',
            },
          },
        ],
        'local-probe',
        {}
      )
    ).rejects.toThrow('BROWSER_LOCAL_PROBE_PATH');
    safeMkdir(scratch, { recursive: true });
    safeWriteFile(`${scratch}/target.png`, Buffer.from('untouched'));
    safeSymlinkSync(`${scratch}/target.png`, `${scratch}/alias.png`, 'file');
    await expect(
      executePipeline(
        [
          {
            type: 'capture',
            op: 'local_session_probe',
            params: {
              path: `${scratch}/alias.png`,
            },
          },
        ],
        'local-probe',
        {}
      )
    ).rejects.toThrow('RESOURCE_PATH_SYMLINK');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('closes both resources when screenshot fails despite keep_alive', async () => {
    mocks.page.screenshot.mockRejectedValueOnce(new Error('screenshot failed'));
    await expect(
      executePipeline([{ type: 'capture', op: 'local_session_probe', params: {} }], 'local-probe', {
        keep_alive: true,
      })
    ).rejects.toThrow('screenshot failed');
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });
});
