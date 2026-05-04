import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';

const mocks = vi.hoisted(() => {
  const pageHandlers = new Map<string, Record<string, Function>>();
  function createPage(
    label: string,
    initialUrl = 'https://example.com',
    initialTitle = 'Test Page'
  ) {
    const handlers: Record<string, Function> = {};
    pageHandlers.set(label, handlers);
    let currentUrl = initialUrl;
    let currentTitle = initialTitle;
    const videoPath = `${process.cwd()}/evidence/browser/videos/${label}.webm`;
    return {
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => undefined),
      innerText: vi.fn(async () => 'content'),
      content: vi.fn(async () => '<html></html>'),
      evaluate: vi.fn(async (arg?: unknown) => {
        if (typeof arg === 'function') {
          return [
            {
              ref: '@e1',
              tag: 'button',
              role: 'button',
              text: 'Submit',
              name: 'Submit',
              type: null,
              placeholder: null,
              href: null,
              value: null,
              visible: true,
              editable: false,
              selector: 'button:nth-of-type(1)',
            },
          ];
        }
        return undefined;
      }),
      title: vi.fn(async () => currentTitle),
      url: vi.fn(() => currentUrl),
      video: vi.fn(() => ({
        path: vi.fn(async () => videoPath),
      })),
      on: vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      __setTitle: (next: string) => {
        currentTitle = next;
      },
      __handlers: handlers,
    };
  }

  const page = createPage('tab-1');
  const page2 = createPage('tab-2', 'https://example.org', 'Second Tab');
  const tracingStart = vi.fn(async () => undefined);
  const tracingStop = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);

  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page2),
    on: vi.fn(),
    clearCookies: vi.fn(async () => undefined),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) => {
        if (method === 'WebAuthn.addVirtualAuthenticator') {
          return { authenticatorId: 'auth-1' };
        }
        if (method === 'WebAuthn.getCredentials') {
          return {
            credentials: [
              {
                credentialId: 'cred-1',
                rpId: 'webauthn.io',
                userName: 'kyberion_passkey_demo',
                signCount: 1,
                isResidentCredential: true,
              },
            ],
          };
        }
        if (method === 'WebAuthn.removeCredential') {
          return {};
        }
        if (method === 'WebAuthn.addCredential') {
          return {};
        }
        return {};
      }),
      on: vi.fn(),
    })),
    close,
    tracing: {
      start: tracingStart,
      stop: tracingStop,
    },
  };

  const connectedBrowser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => undefined),
  };

  const launchPersistentContext = vi.fn(async () => context);
  const connectOverCDP = vi.fn(async () => connectedBrowser);

  return {
    page,
    page2,
    context,
    connectedBrowser,
    launchPersistentContext,
    connectOverCDP,
    close,
    tracingStart,
    tracingStop,
    pageHandlers,
  };
});

vi.mock('@playwright/test', async () => {
  const actual = await vi.importActual<typeof import('@playwright/test')>('@playwright/test');
  return {
    ...actual,
    chromium: {
      launchPersistentContext: mocks.launchPersistentContext,
      connectOverCDP: mocks.connectOverCDP,
    },
  };
});

describe('browser-actuator v3 contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetBrowserRuntimeLeasesForTest } = await import('./index');
    await resetBrowserRuntimeLeasesForTest();
  });

  it('captures a snapshot and reuses ref selectors for ref-based actions', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } },
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
      ],
      options: { headless: true },
    });

    expect(mocks.launchPersistentContext).toHaveBeenCalled();
    expect(mocks.page.click).toHaveBeenCalledWith('button:nth-of-type(1)', { timeout: 5000 });
    expect(mocks.page.fill).toHaveBeenCalledWith('button:nth-of-type(1)', 'hello', {
      timeout: 5000,
    });
    expect(result.context.snapshot).toMatchObject({
      session_id: 'browser-test',
      title: 'Test Page',
      url: 'https://example.com',
      element_count: 1,
    });
    expect(result.context.ref_map).toEqual({
      '@e1': 'button:nth-of-type(1)',
    });
  });

  it('accepts computer_interaction snapshot requests and enriches them with observation outputs', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'computer-session',
      observation: {
        mode: 'mixed',
        include_screenshot: true,
        include_console: true,
        include_network: true,
      },
      action: {
        type: 'snapshot',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.last_snapshot).toMatchObject({
      session_id: 'computer-session',
      title: 'Test Page',
    });
    expect(result.context.last_screenshot).toBeDefined();
    expect(result.context.console_events).toEqual([]);
    expect(result.context.network_events).toEqual([]);
  });

  it('accepts computer_interaction ref actions through the browser executor', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'computer-session',
      action: {
        type: 'click_ref',
        ref: '@e1',
      },
    } as any);

    expect(result.status).toBe('succeeded');
    expect(mocks.page.click).toHaveBeenCalledWith('button:nth-of-type(1)', { timeout: 5000 });
  });

  it('fails fast when a ref action is used before snapshot capture', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [{ type: 'apply', op: 'click_ref', params: { ref: '@missing' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      op: 'click_ref',
      status: 'failed',
    });
    expect(String(result.results[0].error)).toContain('Unknown browser ref');
  });

  it('tracks tabs and exports console/network observations', async () => {
    const { handleAction } = await import('./index');

    mocks.page2.goto.mockImplementationOnce(async (url: string) => {
      const handlers = mocks.pageHandlers.get('tab-2') || {};
      handlers.console?.({ type: () => 'log', text: () => 'hello from tab 2' });
      handlers.request?.({
        method: () => 'GET',
        url: () => `${url}/api`,
        resourceType: () => 'fetch',
      });
    });

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        {
          type: 'control',
          op: 'open_tab',
          params: { url: 'https://example.org', tab_id: 'research' },
        },
        { type: 'control', op: 'select_tab', params: { tab_id: 'research' } },
        { type: 'capture', op: 'tabs', params: { export_as: 'tabs' } },
        { type: 'capture', op: 'console', params: { export_as: 'console' } },
        { type: 'capture', op: 'network', params: { export_as: 'network' } },
      ],
      options: { headless: true },
    });

    expect(result.context.tabs).toEqual([
      expect.objectContaining({ tab_id: 'tab-1', active: false }),
      expect.objectContaining({ tab_id: 'research', active: true }),
    ]);
    expect(result.context.console).toEqual([
      expect.objectContaining({ tab_id: 'research', text: 'hello from tab 2' }),
    ]);
    expect(result.context.network).toEqual([
      expect.objectContaining({ tab_id: 'research', url: 'https://example.org/api' }),
    ]);
  });

  it('records action trails and exports playwright/adf artifacts', async () => {
    const { handleAction } = await import('./index');
    const outDir = path.join(process.cwd(), 'active/shared/tmp/browser');
    safeMkdir(outDir, { recursive: true });
    const specPath = path.join(outDir, 'browser-test-playwright.spec.ts');
    const adfPath = path.join(outDir, 'browser-test-pipeline.json');
    if (safeExistsSync(specPath)) safeRmSync(specPath, { force: true });
    if (safeExistsSync(adfPath)) safeRmSync(adfPath, { force: true });

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } },
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
        {
          type: 'capture',
          op: 'content',
          params: { selector: 'button:nth-of-type(1)', export_as: 'content' },
        },
        {
          type: 'transform',
          op: 'export_playwright',
          params: { path: specPath, export_as: 'spec_path', assertions: 'strict' },
        },
        { type: 'transform', op: 'export_adf', params: { path: adfPath, export_as: 'adf_path' } },
      ],
      options: { headless: true },
    });

    expect(result.context.action_trail).toEqual([
      expect.objectContaining({ op: 'snapshot', kind: 'capture' }),
      expect.objectContaining({ op: 'click_ref', kind: 'apply', ref: '@e1' }),
      expect.objectContaining({ op: 'fill_ref', kind: 'apply', ref: '@e1', text: 'hello' }),
      expect.objectContaining({
        op: 'content',
        kind: 'capture',
        selector: 'button:nth-of-type(1)',
      }),
    ]);
    expect(result.context.spec_path).toBe(specPath);
    expect(result.context.adf_path).toBe(adfPath);
    const spec = safeReadFile(specPath, { encoding: 'utf8' }) as string;
    expect(spec).toContain('await expect(page).toHaveURL("https://example.com");');
    expect(spec).toContain('await expect(page).toHaveTitle("Test Page");');
    expect(spec).toContain('await expect(page.locator("button:nth-of-type(1)")).toBeVisible();');
    expect(spec).toContain('await page.click("button:nth-of-type(1)");');
    expect(spec).toContain('await page.fill("button:nth-of-type(1)", "hello");');
    expect(spec).toContain(
      'await expect(page.locator("button:nth-of-type(1)")).toHaveValue("hello");'
    );
    expect(spec).toContain(
      'await expect(page.locator("button:nth-of-type(1)")).toContainText("content");'
    );
    expect(JSON.parse(safeReadFile(adfPath, { encoding: 'utf8' }) as string)).toMatchObject({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [
        { type: 'apply', op: 'click_ref', params: { ref: '@e1' } },
        { type: 'apply', op: 'fill_ref', params: { ref: '@e1', text: 'hello' } },
      ],
    });
  });

  it('reuses leased browser sessions within the same process and can close them explicitly', async () => {
    const { handleAction } = await import('./index');

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'capture', op: 'tabs', params: { export_as: 'tabs' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(mocks.launchPersistentContext).toHaveBeenCalledTimes(1);

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-lease',
      steps: [{ type: 'control', op: 'close_session', params: {} }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('exposes recorded video artifacts for test-scoped sessions', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-video',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: {
        headless: true,
        record_video: true,
        video_artifact_dir: 'active/shared/tmp/browser-videos/browser-video',
      },
    });

    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        recordVideo: {
          dir: path.resolve(process.cwd(), 'active/shared/tmp/browser-videos/browser-video'),
        },
      })
    );
    expect(result.context.video_output_dir).toBe(
      path.resolve(process.cwd(), 'active/shared/tmp/browser-videos/browser-video')
    );
    expect(result.context.video_recording_pending).toBe(false);
    expect(result.context.recorded_videos).toEqual([
      path.join(process.cwd(), 'evidence/browser/videos', 'tab-1.webm'),
    ]);
  });

  it('marks video recording as pending for leased sessions kept alive after the test flow', async () => {
    const { handleAction } = await import('./index');
    const videoOutputDir = 'active/shared/tmp/browser-videos/browser-video-lease';

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-video-lease',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: {
        headless: true,
        record_video: true,
        lease_ms: 60_000,
        video_artifact_dir: videoOutputDir,
      },
    });

    expect(result.context.video_recording_pending).toBe(true);
    expect(result.context.recorded_videos).toEqual([]);
    expect(result.context.video_output_dir).toBe(path.resolve(process.cwd(), videoOutputDir));
  });

  it('configures a virtual passkey authenticator and inspects stored credentials', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-passkey',
      steps: [
        {
          type: 'control',
          op: 'setup_passkey_authenticator',
          params: { export_as: 'authenticator' },
        },
        { type: 'capture', op: 'passkey_credentials', params: { export_as: 'credentials' } },
        { type: 'apply', op: 'set_passkey_user_verified', params: { is_user_verified: false } },
        { type: 'apply', op: 'set_passkey_presence', params: { enabled: false } },
        { type: 'apply', op: 'clear_passkey_credentials', params: {} },
      ],
      options: { headless: true },
    });

    expect(mocks.context.newCDPSession).toHaveBeenCalledTimes(1);
    const cdp = await mocks.context.newCDPSession.mock.results[0].value;
    expect(cdp.send).toHaveBeenCalledWith('WebAuthn.enable', { enableUI: false });
    expect(cdp.send).toHaveBeenCalledWith(
      'WebAuthn.addVirtualAuthenticator',
      expect.objectContaining({
        options: expect.objectContaining({
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
        }),
      })
    );
    expect(result.context.authenticator).toMatchObject({
      authenticator_id: 'auth-1',
      protocol: 'ctap2',
      transport: 'internal',
    });
    expect(result.context.credentials).toEqual([
      expect.objectContaining({
        credentialId: 'cred-1',
        rpId: 'webauthn.io',
      }),
    ]);
    expect(cdp.send).toHaveBeenCalledWith('WebAuthn.setUserVerified', {
      authenticatorId: 'auth-1',
      isUserVerified: false,
    });
    expect(cdp.send).toHaveBeenCalledWith('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: 'auth-1',
      enabled: false,
    });
    expect(cdp.send).toHaveBeenCalledWith('WebAuthn.clearCredentials', {
      authenticatorId: 'auth-1',
    });
  });

  it('provides high-level register, authenticate, and delete passkey flows', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-passkey-flow',
      context: { username: 'kyberion_passkey_demo' },
      steps: [
        {
          type: 'apply',
          op: 'register_passkey',
          params: { provider: 'webauthn.io', username: '{{username}}', export_as: 'registration' },
        },
        {
          type: 'apply',
          op: 'authenticate_passkey',
          params: {
            provider: 'webauthn.io',
            username: '{{username}}',
            export_as: 'authentication',
          },
        },
        {
          type: 'apply',
          op: 'delete_passkey',
          params: { username: '{{username}}', export_as: 'deletion' },
        },
      ],
      options: { headless: true },
    });

    expect(mocks.page.goto).toHaveBeenCalledWith('https://webauthn.io/', {
      waitUntil: 'networkidle',
    });
    expect(mocks.context.clearCookies).toHaveBeenCalled();
    expect(mocks.page.fill).toHaveBeenCalledWith('#input-email', 'kyberion_passkey_demo', {
      timeout: 5000,
    });
    expect(mocks.page.click).toHaveBeenCalledWith('#register-button', { timeout: 5000 });
    expect(mocks.page.click).toHaveBeenCalledWith('#login-button', { timeout: 5000 });
    const cdp = await mocks.context.newCDPSession.mock.results[0].value;
    expect(cdp.send).toHaveBeenCalledWith('WebAuthn.removeCredential', {
      authenticatorId: 'auth-1',
      credentialId: 'cred-1',
    });
    expect(result.context.registration).toMatchObject({
      provider: 'webauthn.io',
      username: 'kyberion_passkey_demo',
    });
    expect(result.context.authentication).toMatchObject({
      provider: 'webauthn.io',
      username: 'kyberion_passkey_demo',
      authenticated: false,
    });
    expect(result.context.deletion).toMatchObject({
      deleted: true,
      deleted_credential_id: 'cred-1',
    });
  });

  it('exports assertion hints in comment-only mode when requested', async () => {
    const { renderPlaywrightSkeleton } = await import('./index');

    const spec = renderPlaywrightSkeleton(
      [
        {
          kind: 'capture',
          op: 'snapshot',
          url: 'https://example.com',
          title: 'Test Page',
          ts: new Date().toISOString(),
        },
        {
          kind: 'apply',
          op: 'click_ref',
          selector: 'button:nth-of-type(1)',
          ref: '@e1',
          element_name: 'Submit',
          element_role: 'button',
          ts: new Date().toISOString(),
        },
      ],
      { assertions: 'hint' }
    );

    expect(spec).toContain(
      '// assertion hint: await expect(page).toHaveURL("https://example.com");'
    );
    expect(spec).toContain('// assertion hint: await expect(page).toHaveTitle("Test Page");');
    expect(spec).toContain(
      '// assertion hint: await expect(page.locator("button:nth-of-type(1)")).toBeVisible();'
    );
    expect(spec).toContain('await page.click("button:nth-of-type(1)");');
  });

  it('groups exported playwright skeleton into recorded actions and assertions with step labels', async () => {
    const { renderPlaywrightSkeleton } = await import('./index');

    const spec = renderPlaywrightSkeleton(
      [
        {
          kind: 'capture',
          op: 'snapshot',
          url: 'https://example.com',
          title: 'Test Page',
          ts: new Date().toISOString(),
        },
        {
          kind: 'apply',
          op: 'click_ref',
          selector: 'button:nth-of-type(1)',
          ref: '@e1',
          element_name: 'Submit',
          element_role: 'button',
          ts: new Date().toISOString(),
        },
        {
          kind: 'apply',
          op: 'fill_ref',
          selector: 'input:nth-of-type(1)',
          ref: '@e2',
          text: 'hello',
          element_name: 'Name',
          element_role: 'textbox',
          ts: new Date().toISOString(),
        },
      ],
      { assertions: 'strict' }
    );

    expect(spec).toContain('// recorded actions');
    expect(spec).toContain('// assertions');
    expect(spec).toContain('// step 1: click @e1');
    expect(spec).toContain('// step 2: fill @e2');
    expect(spec).toContain('// before click: Submit');
    expect(spec).toContain('// before fill: Name');
    expect(spec).toContain('// value assertion');
  });

  it('closes and restarts browser sessions through exported helpers', async () => {
    const { handleAction, closeBrowserSession, restartBrowserSession } = await import('./index');

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-admin',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(await restartBrowserSession('browser-admin')).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-admin',
      steps: [{ type: 'capture', op: 'tabs', params: { export_as: 'tabs' } }],
      options: { headless: true, lease_ms: 60_000 },
    });

    expect(await closeBrowserSession('browser-admin')).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it('pauses for operator continuation using a continue file in non-tty mode', async () => {
    const { handleAction } = await import('./index');
    const outDir = path.join(process.cwd(), 'active/shared/tmp/browser');
    safeMkdir(outDir, { recursive: true });
    const continueFile = path.join(outDir, 'browser-operator.continue');
    if (safeExistsSync(continueFile)) safeRmSync(continueFile, { force: true });

    const stdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    setTimeout(() => {
      safeWriteFile(continueFile, 'continue\n');
    }, 25);

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-pause',
      steps: [
        {
          type: 'control',
          op: 'pause_for_operator',
          params: { continue_file: continueFile, poll_ms: 10, timeout_ms: 500 },
        },
      ],
      options: { headless: true },
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTTY, configurable: true });
    expect(safeExistsSync(continueFile)).toBe(true);
  });

  it('selects a tab by URL pattern before capture', async () => {
    const { handleAction } = await import('./index');

    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-select-tab-matching',
      steps: [
        {
          type: 'control',
          op: 'open_tab',
          params: {
            tab_id: 'rakuten-tab',
            url: 'https://travel.rakuten.co.jp/',
            waitUntil: 'domcontentloaded',
          },
        },
        {
          type: 'control',
          op: 'select_tab_matching',
          params: { url_includes: 'travel.rakuten.co.jp' },
        },
        { type: 'capture', op: 'tabs', params: { export_as: 'tabs' } },
      ],
      options: { headless: true },
    });

    expect(result.context.active_tab_id).toBe('rakuten-tab');
    expect(result.context.tabs.find((tab: any) => tab.tab_id === 'rakuten-tab')?.active).toBe(true);
  });

  it('passes existing chrome profile launch options to playwright persistent context', async () => {
    const { handleAction } = await import('./index');

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-profile',
      steps: [{ type: 'capture', op: 'snapshot', params: { export_as: 'snapshot' } }],
      options: {
        headless: true,
        browser_channel: 'chrome',
        user_data_dir: 'active/shared/tmp/browser/chrome-profile',
        profile_directory: 'Profile 1',
        launch_args: ['--disable-features=Translate'],
      },
    });

    expect(mocks.launchPersistentContext).toHaveBeenLastCalledWith(
      path.resolve(process.cwd(), 'active/shared/tmp/browser/chrome-profile'),
      expect.objectContaining({
        channel: 'chrome',
        args: [
          '--disable-features=Translate',
          '--profile-directory=Profile 1',
          '--remote-debugging-port=0',
        ],
      })
    );
  });

  it('attaches to an existing Chrome instance over CDP without launching a new browser', async () => {
    const { handleAction, closeBrowserSession } = await import('./index');

    await handleAction({
      action: 'pipeline',
      session_id: 'browser-cdp',
      steps: [{ type: 'capture', op: 'tabs', params: { export_as: 'tabs' } }],
      options: {
        connect_over_cdp: true,
        cdp_port: 9333,
        lease_ms: 60_000,
      },
    });

    expect(mocks.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9333');
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();

    expect(await closeBrowserSession('browser-cdp')).toBe(true);
    expect(mocks.connectedBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('reattaches to a retained browser session via persisted CDP metadata across processes', async () => {
    const { handleAction, resetBrowserRuntimeLeasesForTest } = await import('./index');
    const sessionId = 'browser-cdp-reconnect';
    await resetBrowserRuntimeLeasesForTest();
    const metadataPath = path.resolve(
      process.cwd(),
      'active/shared/runtime/browser/sessions',
      `${sessionId}.json`
    );
    safeMkdir(path.dirname(metadataPath), { recursive: true });
    safeWriteFile(
      metadataPath,
      JSON.stringify(
        {
          session_id: sessionId,
          user_data_dir: path.resolve(process.cwd(), 'active/shared/runtime/browser', sessionId),
          active_tab_id: 'tab-1',
          tab_count: 1,
          tabs: [{ tab_id: 'tab-1', url: 'https://example.com', title: 'Test Page', active: true }],
          updated_at: new Date().toISOString(),
          lease_status: 'active',
          retained: true,
          cdp_url: 'http://127.0.0.1:9334',
          cdp_port: 9334,
          action_trail_count: 1,
          recent_actions: [],
        },
        null,
        2
      )
    );

    const result = await handleAction({
      action: 'pipeline',
      session_id: sessionId,
      steps: [{ type: 'capture', op: 'tabs', params: { export_as: 'tabs' } }],
      options: {
        headless: true,
        lease_ms: 60_000,
      },
    });

    expect(result.status).toBe('succeeded');
    expect(mocks.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9334');
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('handles pipeline with unsupported action gracefully', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-test',
      steps: [{ type: 'apply', op: 'unknown_op', params: {} }],
      options: { headless: true },
    });

    // Unknown ops should fail gracefully
    expect(result.status).toBe('failed');
  });

  it('handles goto navigation', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-nav',
      steps: [{ type: 'apply', op: 'goto', params: { url: 'https://example.com' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('succeeded');
    expect(mocks.page.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
  });

  it('handles screenshot capture', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-screenshot',
      steps: [{ type: 'capture', op: 'screenshot', params: { export_as: 'screenshot' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('succeeded');
    expect(mocks.page.screenshot).toHaveBeenCalled();
  });

  it('handles page content capture', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-content',
      steps: [{ type: 'capture', op: 'content', params: { export_as: 'page_content' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.page_content).toBe('<html></html>');
  });

  it('handles page title capture', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-title',
      steps: [{ type: 'capture', op: 'title', params: { export_as: 'page_title' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.page_title).toBe('Test Page');
  });

  it('handles url capture', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'pipeline',
      session_id: 'browser-url',
      steps: [{ type: 'capture', op: 'url', params: { export_as: 'current_url' } }],
      options: { headless: true },
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.current_url).toBe('https://example.com');
  });
});
