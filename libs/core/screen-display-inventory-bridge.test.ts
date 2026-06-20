import { describe, expect, it } from 'vitest';
import { createScreenDisplayInventoryBridge, SCREEN_DISPLAY_INVENTORY_BRIDGE_ID } from './screen-display-inventory-bridge.js';

describe('createScreenDisplayInventoryBridge', () => {
  it('parses macOS display inventory payloads', async () => {
    const bridge = createScreenDisplayInventoryBridge({
      platform: 'darwin',
      command_runner: (command, args) => {
        expect(command).toBe('system_profiler');
        expect(args).toEqual(['SPDisplaysDataType', '-json']);
        return {
          stdout: JSON.stringify({
            SPDisplaysDataType: [
              {
                _items: [
                  {
                    _name: 'Built-in Retina Display',
                    spdisplays_main: 'spdisplays_yes',
                    spdisplays_resolution: '3456 x 2234',
                  },
                  {
                    _name: 'DELL U2720Q',
                    spdisplays_resolution: '3840 x 2160',
                  },
                ],
              },
            ],
          }),
          stderr: '',
          status: 0,
        };
      },
    });

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(SCREEN_DISPLAY_INVENTORY_BRIDGE_ID);
    expect(probe.available).toBe(true);
    expect(probe.inventory.displays.map((d) => d.name)).toEqual([
      'Built-in Retina Display',
      'DELL U2720Q',
    ]);
    expect(probe.inventory.displays[0].primary).toBe(true);
    expect(probe.inventory.displays[0].width).toBe(3456);
    expect(probe.inventory.displays[0].height).toBe(2234);
  });

  it('parses xrandr display inventory payloads', async () => {
    const bridge = createScreenDisplayInventoryBridge({
      platform: 'linux',
      command_runner: (command, args) => {
        expect(command).toBe('xrandr');
        expect(args).toEqual(['--query']);
        return {
          stdout: [
            'eDP-1 connected primary 3456x2234+0+0 (normal left inverted right x axis y axis) 309mm x 194mm',
            'HDMI-1 connected 3840x2160+3456+0 (normal left inverted right x axis y axis) 600mm x 340mm',
          ].join('\n'),
          stderr: '',
          status: 0,
        };
      },
    });

    const probe = await bridge.probe();
    expect(probe.inventory.displays.map((d) => d.name)).toEqual(['eDP-1', 'HDMI-1']);
    expect(probe.inventory.displays[0].primary).toBe(true);
    expect(probe.inventory.displays[1].width).toBe(3840);
    expect(probe.inventory.displays[1].height).toBe(2160);
  });
});
