import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { safeExec, safeReadFile, safeExistsSync, safeWriteFile, pathResolver } from '../libs/core/index.js';
import * as path from 'node:path';

const ROOT_DIR = pathResolver.rootDir();
const TEST_MISSION_ID = 'MSN-TEST-LIFE-A2A';
const AGENT_ID = 'Test-Agent-X';
const LEDGER_PATH = path.join(ROOT_DIR, 'knowledge/personal/governance/agent-trust-scores.json');

function runMissionController(...args: string[]) {
  return safeExec('node', ['--import', 'tsx', 'scripts/mission_controller.ts', ...args], {
    env: { ...process.env, MISSION_ROLE: 'mission_controller' },
  });
}

describe('A2A Mission Lifecycle & Trust Engine Integration', () => {
  
  beforeAll(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    // Ensure we start with a clean slate for the test agent
    if (safeExistsSync(LEDGER_PATH)) {
      const ledger = JSON.parse(safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string);
      delete ledger.agents[AGENT_ID];
      safeWriteFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    }
  });

  it('Scenario 1: Full Success Flow (Verified & Score Increase)', async () => {
    // 1. Create Mission
    runMissionController('start', TEST_MISSION_ID, 'personal');
    
    // 2. Delegate
    runMissionController('delegate', TEST_MISSION_ID, AGENT_ID, 'MSG-SUCCESS');
    
    // 3. Verify
    runMissionController('verify', TEST_MISSION_ID, 'verified', 'Good work');
    
    // 4. Check Score
    const ledger = JSON.parse(safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string);
    expect(ledger.agents[AGENT_ID].current_score).toBe(5.5);
    expect(ledger.agents[AGENT_ID].total_missions).toBe(1);
    
    // Cleanup for next test
    runMissionController('finish', TEST_MISSION_ID);
  });

  it('Scenario 2: Failure Flow (Rejected & Score Decrease)', async () => {
    const FAIL_MISSION_ID = 'MSN-TEST-LIFE-FAIL';
    
    // 1. Create and Delegate
    runMissionController('start', FAIL_MISSION_ID, 'personal');
    runMissionController('delegate', FAIL_MISSION_ID, AGENT_ID, 'MSG-FAIL');
    
    // 2. Verify with Rejection
    runMissionController('verify', FAIL_MISSION_ID, 'rejected', 'Poor work');
    
    // 3. Check Score (5.5 - 1.0 = 4.5)
    const ledger = JSON.parse(safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string);
    expect(ledger.agents[AGENT_ID].current_score).toBe(4.5);
    
    runMissionController('finish', FAIL_MISSION_ID);
  });

  it('Scenario 3: Trust Guardrail (Insufficient Score)', async () => {
    const GUARD_MISSION_ID = 'MSN-TEST-LIFE-GUARD';
    const LOW_TRUST_AGENT = 'Agent-Bad';

    // 1. Manually set a low score
    const ledger = JSON.parse(safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string);
    ledger.agents[LOW_TRUST_AGENT] = {
      current_score: 2.0,
      total_missions: 0,
      success_rate: 0,
      performance: { consecutive_successes: 0 },
      history: []
    };
    safeWriteFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));

    // 2. Try to delegate a personal mission (Should fail)
    runMissionController('start', GUARD_MISSION_ID, 'personal');
    
    try {
      runMissionController('delegate', GUARD_MISSION_ID, LOW_TRUST_AGENT, 'MSG-X');
      throw new Error('Should have failed due to low trust');
    } catch (err: any) {
      expect(err.message).toContain('insufficient trust score');
    }

    runMissionController('finish', GUARD_MISSION_ID);
  });
});
