import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';

describe('daemon-actuator retirement', () => {
  it('fails fast with runtime supervision guidance', async () => {
    await expect(handleAction({ action: 'run-once' })).rejects.toThrow('daemon-actuator is retired');
  });
});
