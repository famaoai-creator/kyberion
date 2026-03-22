import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';

describe('physical-bridge retirement', () => {
  it('fails fast with migration guidance', async () => {
    await expect(handleAction({ actions: [] })).rejects.toThrow('physical-bridge is retired');
  });
});
