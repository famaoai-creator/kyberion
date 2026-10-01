import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real path resolver + catalogs (android-ui-defaults.json); only the device is faked.
const execCalls = vi.hoisted(() => [] as string[][]);

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExec: vi.fn((_bin: string, args: string[] = []) => {
    execCalls.push(args);
    if (args[0] === 'version') return 'Android Debug Bridge version 1.0.41';
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice';
    return '';
  }),
}));

const UI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Use passkey" resource-id="com.example:id/passkey" class="android.widget.Button" package="com.example" content-desc="" bounds="[100,200][300,400]" clickable="true" enabled="true" />
</hierarchy>`;

describe('android-actuator authenticate_with_passkey', () => {
  beforeEach(() => {
    execCalls.length = 0;
  });

  it('plans the passkey trigger tap in dry_run without touching the device', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: { last_ui_tree: UI_XML },
      steps: [{ type: 'apply', op: 'authenticate_with_passkey', params: { dry_run: true } }],
    });
    expect(result.status).toBe('succeeded');
    // The trigger text comes from android-ui-defaults.json ("passkey").
    expect(result.context.last_passkey_plan.trigger).toMatchObject({
      text: 'Use passkey',
      x: 200,
      y: 300,
    });
    expect(execCalls.some((args) => args.includes('tap'))).toBe(false);
  });

  it('taps the resolved trigger on the device when not a dry run', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'pipeline',
      context: { last_ui_tree: UI_XML },
      steps: [{ type: 'apply', op: 'authenticate_with_passkey', params: {} }],
    });
    expect(result.status).toBe('succeeded');
    expect(execCalls).toContainEqual(['shell', 'input', 'tap', '200', '300']);
  });
});
