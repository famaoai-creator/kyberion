import { describe, expect, it } from 'vitest';
import { parseUiAutomatorNodes } from './android-runtime-helpers.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
        bounds="[0,0][1080,2400]" clickable="false">
    <node index="1" text="Sign in" resource-id="com.example:id/login"
          class="android.widget.Button" content-desc="Login button"
          bounds="[100,800][980,920]" clickable="true"/>
    <node index="2" text="Forgot &amp; password?" resource-id=""
          class="android.widget.TextView" bounds="[200,960][880,1020]" clickable="true"/>
  </node>
</hierarchy>`;

describe('parseUiAutomatorNodes', () => {
  it('flattens nodes with bounds into a normalized list', () => {
    const nodes = parseUiAutomatorNodes(XML);
    expect(nodes).toHaveLength(3);
    const login = nodes.find((n) => n.text === 'Sign in');
    expect(login).toBeDefined();
    expect(login!.resource_id).toBe('com.example:id/login');
    expect(login!.clickable).toBe(true);
    expect(login!.center).toEqual({ x: 540, y: 860 });
  });

  it('decodes XML entities in attributes', () => {
    const nodes = parseUiAutomatorNodes(XML);
    expect(nodes[2].text).toBe('Forgot & password?');
  });

  it('returns an empty list for unparsable input', () => {
    expect(parseUiAutomatorNodes('not xml')).toEqual([]);
  });
});

describe('op catalog registration', () => {
  it('advertises describe_ui + stream ops added by MSN-MOBILE-ACT-20261028', async () => {
    const { describeOps } = await import('./op-catalog.js');
    const names = new Set(describeOps().map((d) => (d as { op?: string }).op));
    for (const step of [
      { op: 'describe_ui' },
      { op: 'start_screen_stream' },
      { op: 'stop_screen_stream' },
      { op: 'stream_status' },
    ]) {
      expect(names.has(step.op), `op ${step.op}`).toBe(true);
    }
  });
});
