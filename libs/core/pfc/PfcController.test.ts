import { getSecret } from '../secret/secret-guard.js';
import { getRegisteredEnvText, setRegisteredEnv } from '../foundation/env.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPfcStateAtPath, PfcController } from './PfcController.js';

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
    expect(loadPfcStateAtPath(STATE_FILE).layers.L0.attempt_count).toBe(3);
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

  it('closes an open circuit when the layer recovers (probe on open circuit)', async () => {
    const controller = new PfcController(STATE_FILE);
    const failLogic = async () => false;
    await controller.runLayer('L10', failLogic);
    await controller.runLayer('L10', failLogic);
    const broken = await controller.runLayer('L10', failLogic);
    expect(broken.circuit_broken).toBe(true);

    // Still broken: the probe runs but the circuit stays open without
    // inflating attempt_count.
    const stillBroken = await controller.runLayer('L10', failLogic);
    expect(stillBroken.circuit_broken).toBe(true);
    expect(controller.getState().layers['L10'].attempt_count).toBe(3);

    // Recovered: the probe passes and the circuit closes.
    const recovered = await controller.runLayer('L10', async () => true);
    expect(recovered.passed).toBe(true);
    expect(recovered.circuit_broken).toBe(false);
    expect(controller.getState().layers['L10'].status).toBe('passed');
    expect(controller.getState().layers['L10'].attempt_count).toBe(0);
  });

  it('falls back to the default state when the persisted state violates its schema', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ layers: { L0: { status: 'unknown' } } }));

    const controller = new PfcController(STATE_FILE);

    expect(controller.getState().layers.L0).toEqual({ status: 'pending', attempt_count: 0 });
  });

  it('rejects a directory at the persisted state path before schema loading', () => {
    fs.mkdirSync(STATE_FILE, { recursive: true });

    expect(() => loadPfcStateAtPath(STATE_FILE)).toThrow('state must be a regular file');
  });
  it('keeps repeated observations out of the repair budget and persists diagnostic evidence', async () => {
    const controller = new PfcController(STATE_FILE);
    for (let i = 0; i < 5; i++) {
      expect(
        await controller.runLayer(
          'L2',
          async () => ({
            passed: false,
            reason: 'missing dist',
            fingerprint: 'dist-a',
            evidence: ['dist/core.js'],
          }),
          { countFailure: false }
        )
      ).toEqual({ passed: false, circuit_broken: false });
    }
    expect(loadPfcStateAtPath(STATE_FILE).layers.L2).toMatchObject({
      attempt_count: 0,
      budget_source: 'recovery',
      last_observation: {
        reason: 'missing dist',
        fingerprint: 'dist-a',
        evidence: ['dist/core.js'],
      },
    });
  });

  it('counts actual recovery attempts once, preserves them during deferred probes, and resets on recovery', async () => {
    const controller = new PfcController(STATE_FILE);
    for (const id of ['a', 'b', 'c']) controller.recordRecoveryAttempt('L2', { id, passed: false });
    controller.recordRecoveryAttempt('L2', { id: 'c', passed: false });
    expect(controller.getState().layers.L2.attempt_count).toBe(3);
    expect(
      await controller.runLayer(
        'L2',
        async () => ({ passed: false, deferred: true, reason: 'building' }),
        { countFailure: false }
      )
    ).toEqual({ passed: false, circuit_broken: true, deferred: true });
    expect(controller.getState().layers.L2.attempt_count).toBe(3);
    controller.recordRecoveryAttempt('L2', { id: 'd', passed: true });
    expect(controller.getState().layers.L2.attempt_count).toBe(0);
  });

  it('migrates legacy observation counts without retaining a false repair circuit', async () => {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ layers: { L2: { status: 'failed', attempt_count: 3 } } })
    );
    const controller = new PfcController(STATE_FILE);
    expect(await controller.runLayer('L2', async () => false, { countFailure: false })).toEqual({
      passed: false,
      circuit_broken: false,
    });
    expect(controller.getState().layers.L2).toMatchObject({
      attempt_count: 0,
      legacy_observation_attempt_count: 3,
    });
  });

  it('merges concurrent controllers after their asynchronous probes without losing unrelated layers', async () => {
    const first = new PfcController(STATE_FILE);
    const second = new PfcController(STATE_FILE);
    let release!: () => void;
    const pending = first.runLayer('L0', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });
    await second.runLayer('L1', async () => false);
    second.recordRecoveryAttempt('L2', { id: 'build-a', passed: false });
    release();
    await pending;
    const state = loadPfcStateAtPath(STATE_FILE);
    expect(state.layers.L0.status).toBe('passed');
    expect(state.layers.L1.attempt_count).toBe(1);
    expect(state.layers.L2.attempt_count).toBe(1);
  });

  it('does not let a stale successful probe erase a recovery failure committed during the probe', async () => {
    const observer = new PfcController(STATE_FILE);
    const builder = new PfcController(STATE_FILE);
    let release!: () => void;
    const pending = observer.runLayer(
      'L2',
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      },
      { countFailure: false }
    );
    builder.recordRecoveryAttempt('L2', { id: 'new-build', passed: false });
    release();
    expect(await pending).toMatchObject({ passed: false, deferred: true });
    expect(observer.getState().layers.L2.attempt_count).toBe(1);
  });

  it('records thrown probe errors as diagnostic reasons', async () => {
    const controller = new PfcController(STATE_FILE);
    await controller.runLayer(
      'L2',
      async () => {
        throw new Error('artifact read failed');
      },
      { countFailure: false }
    );
    expect(controller.getState().layers.L2.last_observation?.reason).toBe('artifact read failed');
  });
  it('keeps a genuine repair budget until full readiness is restored', () => {
    const controller = new PfcController(STATE_FILE);
    for (const id of ['a', 'b', 'c']) controller.recordRecoveryAttempt('L2', { id, passed: false });
    controller.recordRecoveryAttempt('L2', { id: 'packages-only', passed: true, restored: false });
    expect(controller.getState().layers.L2).toMatchObject({ status: 'failed', attempt_count: 3 });
    controller.recordRecoveryAttempt('L2', { id: 'fully-ready', passed: true, restored: true });
    expect(controller.getState().layers.L2).toMatchObject({ status: 'passed', attempt_count: 0 });
  });

  it('redacts registered secrets and bounds persisted diagnostic output', async () => {
    const secret = 'pfc-test-secret-value-20261018';
    const previous = getRegisteredEnvText('OPENAI_API_KEY');
    setRegisteredEnv('OPENAI_API_KEY', secret);
    try {
      expect(getSecret('OPENAI_API_KEY')).toBe(secret);
      const controller = new PfcController(STATE_FILE);
      const huge = secret + 'x'.repeat(10000);
      controller.recordRecoveryAttempt('L2', { id: 'build', passed: false, reason: huge });
      await controller.runLayer(
        'L2',
        async () => ({
          passed: false,
          reason: huge,
          fingerprint: huge,
          evidence: Array.from({ length: 100 }, () => huge),
        }),
        { countFailure: false }
      );
      const state = loadPfcStateAtPath(STATE_FILE).layers.L2;
      expect(fs.readFileSync(STATE_FILE, 'utf8')).not.toContain(secret);
      expect(state.last_recovery?.reason?.length).toBeLessThanOrEqual(2048);
      expect(state.last_observation?.evidence).toHaveLength(25);
      expect(state.last_observation?.fingerprint?.length).toBeLessThanOrEqual(128);
    } finally {
      setRegisteredEnv('OPENAI_API_KEY', previous);
    }
  });
});
