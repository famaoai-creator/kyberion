import { describe, expect, it } from 'vitest';
import { main } from './vault_mount_cli.js';

describe('vault_mount_cli', () => {
  it('lists mounts in json format', async () => {
    const outputs: string[] = [];
    const print = (msg: string) => outputs.push(msg);

    await main(['list', '--json'], print);

    expect(outputs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(outputs[0]);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
