import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';

describe('physical-bridge retirement', () => {
  it('fails fast with migration guidance', async () => {
    await expect(handleAction({ actions: [] })).rejects.toThrow('physical-bridge is retired');
  });

  it('throws with ADF orchestration guidance', async () => {
    await expect(handleAction({})).rejects.toThrow('ADF orchestration');
  });

  it('throws with browser-actuator reference', async () => {
    await expect(handleAction({ auto_observe: true })).rejects.toThrow('browser-actuator');
  });

  it('throws with system-actuator reference', async () => {
    await expect(handleAction({ session_id: 'test-session' })).rejects.toThrow('system-actuator');
  });

  it('throws regardless of input shape', async () => {
    await expect(handleAction({ actions: [{ type: 'click', x: 100, y: 200 }] })).rejects.toThrow(
      'physical-bridge is retired'
    );
    await expect(handleAction({ auto_observe: false, session_id: 'abc' })).rejects.toThrow(
      'physical-bridge is retired'
    );
  });
});
