import { describe, expect, it } from 'vitest';
import { createVirtualInputDeviceInventoryBridge, VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID } from './virtual-input-device-inventory-bridge.js';

function makeCommandRunner() {
  return (command: string, args: string[]) => {
    if (command === 'hidutil' && args[0] === 'list') {
      return {
        stdout: [
          'Devices:',
          'VendorID ProductID LocationID UsagePage Usage RegistryID Transport Class Product UserClass Built-In',
          '0x46d    0xb041    0x5ad941ac 1         2     0x1001cffb7 Bluetooth Low Energy IOHIDUserDevice ERGO M575SP                  (null)                    0',
          '0xa5c    0x8502    0x100109f6 1         6     0x100001b29 Bluetooth            IOHIDUserDevice MINILA-R Convertible        (null)                    0',
          '0x0      0x0       0x0        65280     255   0x100000876 SPU                  AppleSPUHIDDevice  Virtual Keyboard            (null)                    1',
        ].join('\n'),
        stderr: '',
        status: 0,
      };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
}

describe('createVirtualInputDeviceInventoryBridge', () => {
  it('scans keyboard and mouse candidates from hidutil', async () => {
    const bridge = createVirtualInputDeviceInventoryBridge({
      command_runner: makeCommandRunner(),
    });

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_INPUT_DEVICE_INVENTORY_BRIDGE_ID);
    expect(probe.available).toBe(true);
    expect(probe.inventory.mice.map((d) => d.name)).toContain('ERGO M575SP');
    expect(probe.inventory.keyboards.map((d) => d.name)).toContain('MINILA-R Convertible');
    expect(probe.inventory.virtual_input_devices.map((d) => d.name)).toContain('Virtual Keyboard');
  });
});
