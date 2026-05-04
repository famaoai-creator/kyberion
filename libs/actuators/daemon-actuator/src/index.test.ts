import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';

describe('daemon-actuator retirement', () => {
  it('fails fast with runtime supervision guidance', async () => {
    await expect(handleAction({ action: 'run-once' })).rejects.toThrow(
      'daemon-actuator is retired'
    );
  });

  it('throws with migration guidance message', async () => {
    await expect(handleAction({})).rejects.toThrow('surface-runtime');
  });

  it('throws with process-actuator reference', async () => {
    await expect(handleAction({ action: 'start', nerve_id: 'test' })).rejects.toThrow(
      'process-actuator'
    );
  });

  it('throws regardless of input shape', async () => {
    await expect(handleAction({ action: 'stop', adf_path: 'some/path.json' })).rejects.toThrow(
      'daemon-actuator is retired'
    );
    await expect(handleAction({ options: { restart: true } })).rejects.toThrow(
      'daemon-actuator is retired'
    );
  });
});
