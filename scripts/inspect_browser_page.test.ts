import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  main,
  formatHumanReport,
  inspectWithFetch,
  type PageInspectionResult,
} from './inspect_browser_page.js';
import { ScriptExitError } from './lib/harness.js';

describe('inspect_browser_page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing URL with ScriptExitError', async () => {
    const print = vi.fn();
    await expect(main([], print, { nodeVersion: 'v24.1.0' })).rejects.toBeInstanceOf(
      ScriptExitError
    );
  });

  it('inspects page with fetch mode statically', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Example Page</title></head>
        <body>
          <h1>Welcome to Test</h1>
          <h2>Subheading</h2>
          <form action="/login">
            <input type="text" name="username" placeholder="Username" id="user-input" required />
            <input type="password" name="password" placeholder="Password" />
            <button type="submit">Log In</button>
          </form>
          <a href="/about">About Us</a>
        </body>
      </html>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      text: async () => mockHtml,
    }) as unknown as typeof fetch;

    const res = await inspectWithFetch('https://example.com', mockFetch);
    expect(res.mode).toBe('fetch');
    expect(res.title).toBe('Test Example Page');
    expect(res.headings).toEqual([
      { level: 'h1', text: 'Welcome to Test' },
      { level: 'h2', text: 'Subheading' },
    ]);
    expect(res.inputs.length).toBe(2);
    expect(res.inputs[0].name).toBe('username');
    expect(res.inputs[0].required).toBe(true);
    expect(res.buttons).toEqual([{ text: 'Log In' }]);
    expect(res.links).toEqual([{ text: 'About Us', href: '/about' }]);
  });

  it('formats human readable report cleanly', () => {
    const sample: PageInspectionResult = {
      mode: 'browser',
      url: 'https://example.com',
      title: 'Sample Title',
      headings: [{ level: 'h1', text: 'Main Heading' }],
      inputs: [{ tag: 'input', type: 'text', name: 'q', placeholder: 'Search...' }],
      buttons: [{ text: 'Submit' }],
      links: [{ text: 'Home', href: 'https://example.com/' }],
      textExcerpt: 'Sample text excerpt...',
    };

    const formatted = formatHumanReport(sample);
    expect(formatted).toContain('🌐 Page: Sample Title');
    expect(formatted).toContain('📍 URL: https://example.com');
    expect(formatted).toContain('[H1] Main Heading');
    expect(formatted).toContain('name="q"');
    expect(formatted).toContain('"Submit"');
  });

  it('runs browser inspection mode with actuator', async () => {
    const handleAction = vi.fn().mockResolvedValue({
      status: 'succeeded',
      context: {
        page_analysis: {
          title: 'Browser Rendered Page',
          url: 'https://example.com/rendered',
          headings: [{ level: 'h1', text: 'SPA Title' }],
          inputs: [{ tag: 'input', name: 'email' }],
          buttons: [{ text: 'Click Me' }],
          links: [{ text: 'Next', href: 'https://example.com/next' }],
          textExcerpt: 'Dynamic rendered content',
        },
      },
    });

    const print = vi.fn();
    const result = await main(['https://example.com', '--json'], print, {
      nodeVersion: 'v24.1.0',
      loadActuator: async () => ({ handleAction }),
    });

    expect(handleAction).toHaveBeenCalled();
    expect(result.mode).toBe('browser');
    expect(result.title).toBe('Browser Rendered Page');
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"title": "Browser Rendered Page"'));
  });

  it('runs cdp inspection mode attaching to existing browser', async () => {
    const handleAction = vi.fn().mockResolvedValue({
      status: 'succeeded',
      context: {
        page_analysis: {
          title: 'CDP Attached Session',
          url: 'https://jal.co.jp/',
          headings: [{ level: 'h1', text: 'JAL 国内線' }],
          inputs: [{ tag: 'input', name: 'departure' }],
          buttons: [{ text: '検索' }],
          links: [{ text: 'ログイン', href: 'https://jal.co.jp/login' }],
          textExcerpt: 'JAL Booking Page Content',
        },
      },
    });

    const print = vi.fn();
    const result = await main(['--mode', 'cdp', '--cdp-port', '9222', '--json'], print, {
      nodeVersion: 'v24.1.0',
      loadActuator: async () => ({ handleAction }),
    });

    expect(handleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          connect_over_cdp: true,
          cdp_port: 9222,
        }),
      })
    );
    expect(result.mode).toBe('cdp');
    expect(result.title).toBe('CDP Attached Session');
  });

  it('runs extension inspection mode receiving data from extension bridge', async () => {
    const mockWaitForExtension = vi.fn().mockResolvedValue({
      mode: 'extension',
      url: 'https://jal.co.jp/dom',
      title: 'Extension Captured Page',
      headings: [{ level: 'h1', text: 'JAL Top' }],
      inputs: [{ tag: 'input', name: 'origin', placeholder: '出発地' }],
      buttons: [{ text: '便を検索' }],
      links: [],
      textExcerpt: 'Real user session content',
    } satisfies PageInspectionResult);

    const print = vi.fn();
    const result = await main(['--mode', 'extension', '--json'], print, {
      nodeVersion: 'v24.1.0',
      waitForExtensionInspection: mockWaitForExtension,
    });

    expect(mockWaitForExtension).toHaveBeenCalledWith({
      port: 8788,
      timeoutMs: 60000,
    });
    expect(result.mode).toBe('extension');
    expect(result.title).toBe('Extension Captured Page');
    expect(print).toHaveBeenCalledWith(
      expect.stringContaining('"title": "Extension Captured Page"')
    );
  });
});
