import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PfcController } from './PfcController.js';

describe('PfcController - State Management', () => {
  const TEST_DIR = path.join(process.cwd(), 'active/shared/tmp/pfc-controller-test');
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

  it('should initialize with default state if no state file exists', () => {
    const controller = new PfcController(STATE_FILE);
    const state = controller.getState();
    
    expect(state).toBeDefined();
    expect(state.layers).toBeDefined();
    expect(state.layers['L0']).toEqual({ status: 'pending', attempt_count: 0 });
  });

  it('should track attempts and trigger circuit breaker after 3 failures', async () => {
    const controller = new PfcController(STATE_FILE);
    
    // Simulate failing L0
    const failLogic = async () => false;

    // Attempt 1
    const result1 = await controller.runLayer('L0', failLogic);
    expect(result1.passed).toBe(false);
    expect(result1.circuit_broken).toBe(false);
    expect(controller.getState().layers['L0'].attempt_count).toBe(1);

    // Attempt 2
    const result2 = await controller.runLayer('L0', failLogic);
    expect(result2.passed).toBe(false);
    expect(result2.circuit_broken).toBe(false);

    // Attempt 3 (Threshold)
    const result3 = await controller.runLayer('L0', failLogic);
    expect(result3.passed).toBe(false);
    expect(result3.circuit_broken).toBe(true);
    expect(controller.getState().layers['L0'].status).toBe('failed');
    
    // State should be persisted to file
    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(savedState.layers['L0'].attempt_count).toBe(3);
  });

  it('should reset attempt count and mark as passed if successful', async () => {
    const controller = new PfcController(STATE_FILE);
    
    // Simulate failing first
    await controller.runLayer('L1', async () => false);
    expect(controller.getState().layers['L1'].attempt_count).toBe(1);

    // Simulate success
    const result = await controller.runLayer('L1', async () => true);
    
    expect(result.passed).toBe(true);
    expect(result.circuit_broken).toBe(false);
    expect(controller.getState().layers['L1'].attempt_count).toBe(0);
    expect(controller.getState().layers['L1'].status).toBe('passed');
  });
});
