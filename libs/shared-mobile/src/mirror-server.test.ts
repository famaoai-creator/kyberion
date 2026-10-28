import { describe, expect, it, afterEach } from 'vitest';
import { startMirrorServer, type MirrorServerHandle } from './mirror-server.js';
import type { FrameSource } from './frame-source.js';
import type { InputInjector } from './input-injector.js';
import { renderViewerHtml } from './viewer-html.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function stubSource(label = 'stub-device'): FrameSource {
  return { label, grab: async () => PNG_1PX };
}

class StubInjector implements InputInjector {
  readonly label = 'stub-device';
  taps: Array<{ x: number; y: number }> = [];
  async tap(x: number, y: number): Promise<void> {
    this.taps.push({ x, y });
  }
  async swipe(): Promise<void> {}
  async inputText(): Promise<void> {}
  async pressButton(): Promise<void> {}
}

let handle: MirrorServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('startMirrorServer', () => {
  it('serves the viewer page with the device label', async () => {
    handle = await startMirrorServer({ frameSource: stubSource(), fps: 5 });
    const res = await fetch(handle.viewerUrl);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('stub-device');
    expect(html).toContain('stream.mjpeg');
  });

  it('streams multipart frames and reports live status', async () => {
    handle = await startMirrorServer({ frameSource: stubSource(), fps: 10 });
    const res = await fetch(handle.streamUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('multipart/x-mixed-replace');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(value && value.length > 0).toBe(true);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const status = await (await fetch(`${handle.viewerUrl}status`)).json();
    expect(status.state).toBe('live');
    expect(status.tap_enabled).toBe(false);
  });

  it('routes POST /tap device coordinates to the injector', async () => {
    const injector = new StubInjector();
    handle = await startMirrorServer({ frameSource: stubSource(), injector, fps: 5 });
    const res = await fetch(`${handle.viewerUrl}tap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 123, y: 456 }),
    });
    expect(res.status).toBe(200);
    expect(injector.taps).toEqual([{ x: 123, y: 456 }]);
  });

  it('rejects taps when read-only and rejects malformed payloads', async () => {
    handle = await startMirrorServer({ frameSource: stubSource(), fps: 5 });
    const res = await fetch(`${handle.viewerUrl}tap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    expect(res.status).toBe(403);
  });

  it('marks state degraded when frame capture keeps failing', async () => {
    const broken: FrameSource = {
      label: 'broken',
      grab: async () => {
        throw new Error('device unplugged');
      },
    };
    handle = await startMirrorServer({ frameSource: broken, fps: 10 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = handle.status();
    expect(status.state).toBe('degraded');
    expect(status.last_error).toContain('unplugged');
  });
});

describe('renderViewerHtml', () => {
  it('escapes the device label and reflects interactivity', () => {
    const dirty = renderViewerHtml({
      deviceLabel: 'ios:<script>alert(1)</script>',
      interactive: false,
    });
    expect(dirty).not.toContain('<script>alert(1)');
    expect(dirty).toContain('read-only');
    const interactive = renderViewerHtml({ deviceLabel: 'dev', interactive: true });
    expect(interactive).toContain('tapToggle');
    expect(interactive).toContain('Click on the screen');
  });
});
