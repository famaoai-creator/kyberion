import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SovereignSentinel } from './SovereignSentinel.js';

describe('SovereignSentinel (Integrated PFC)', () => {
  const TEST_DIR = path.join(process.cwd(), 'active/shared/tmp/pfc-sentinel-test');
  const STATE_FILE = path.join(TEST_DIR, 'pfc-state.json');

  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      fs.rmSync(STATE_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should pass fast path if all registered layers are valid', async () => {
    const sentinel = new SovereignSentinel(STATE_FILE);

    sentinel.registerLayer('L0', async () => true);
    sentinel.registerLayer('L1', async () => true);

    const result = await sentinel.run();
    expect(result.success).toBe(true);
    expect(result.failedLayer).toBeUndefined();
  });

  it('should halt execution if a layer fails and record state', async () => {
    const sentinel = new SovereignSentinel(STATE_FILE);

    // L0 fails
    sentinel.registerLayer('L0', async () => false);
    // L1 should not be reached
    let l1Reached = false;
    sentinel.registerLayer('L1', async () => {
      l1Reached = true;
      return true;
    });

    const result = await sentinel.run();
    expect(result.success).toBe(false);
    expect(result.failedLayer).toBe('L0');
    expect(l1Reached).toBe(false); // L1 was never executed

    // Check state persistence
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.layers['L0'].attempt_count).toBe(1);
    expect(state.layers['L1'].attempt_count).toBe(0);
  });

  it('runs every registered layer through L7, not just L0-L5', async () => {
    const sentinel = new SovereignSentinel(STATE_FILE);
    const reached: string[] = [];
    for (const layer of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const) {
      sentinel.registerLayer(layer, async () => {
        reached.push(layer);
        return true;
      });
    }

    const result = await sentinel.run();

    expect(result.success).toBe(true);
    expect(reached).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  });

  it('halts on L6 without reaching L7', async () => {
    const sentinel = new SovereignSentinel(STATE_FILE);
    let l7Reached = false;
    sentinel.registerLayer('L6', async () => false);
    sentinel.registerLayer('L7', async () => {
      l7Reached = true;
      return true;
    });

    const result = await sentinel.run();

    expect(result.success).toBe(false);
    expect(result.failedLayer).toBe('L6');
    expect(l7Reached).toBe(false);
  });
});
